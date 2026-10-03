import { z } from "zod";
import {
  badRequest,
  type Caller,
  conflict,
  type Ctx,
  forbidden,
  notFound,
  requireAdmin,
  requireUser,
} from "../context.ts";
import type { GroupRole, GroupsTable } from "../db/schema.ts";
import { addDays, newId } from "../lib/util.ts";
import { audit } from "./audit.ts";
import { inviteEffect } from "./auth.ts";
import { statusesFor } from "./clearances.ts";
import {
  consumeInvite,
  createInvite,
  findInvite,
  inviteProblem,
} from "./invites.ts";
import { getUser, isMinor, summarise } from "./people.ts";
import { guardianship } from "../../shared/settings.ts";
import { getSettings } from "./settings.ts";

export const groupInput = z.object({
  name: z.string().trim().min(1).max(100),
  code: z
    .string()
    .trim()
    .max(40)
    .nullable()
    .default(null)
    .transform((code) => code || null),
});

async function roleIn(
  ctx: Ctx,
  groupId: string,
  userId: string,
): Promise<GroupRole | null> {
  const row = await ctx.db
    .selectFrom("group_members")
    .select("role")
    .where("group_id", "=", groupId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return row?.role ?? null;
}

/** Admins and the group's own managers run a group. */
async function requireGroupManager(ctx: Ctx, caller: Caller, groupId: string) {
  const user = requireUser(caller);
  const group = await ctx.db
    .selectFrom("groups")
    .selectAll()
    .where("id", "=", groupId)
    .executeTakeFirst();
  if (!group) throw notFound("That group does not exist.");
  if (!user.is_admin && (await roleIn(ctx, groupId, user.id)) !== "manager") {
    throw forbidden("Only a manager of this group can do that.");
  }
  return { user, group };
}

export async function listGroups(ctx: Ctx, caller: Caller) {
  const user = requireUser(caller);
  const [groups, memberships, counts] = await Promise.all([
    ctx.db.selectFrom("groups").selectAll().orderBy("name").execute(),
    ctx.db
      .selectFrom("group_members")
      .select(["group_id", "role"])
      .where("user_id", "=", user.id)
      .execute(),
    ctx.db
      .selectFrom("group_members")
      .select((eb) => ["group_id", eb.fn.countAll().as("members")])
      .groupBy("group_id")
      .execute(),
  ]);
  const roles = new Map(memberships.map((m) => [m.group_id, m.role]));
  return groups
    .filter(
      (group) => user.is_admin || (roles.has(group.id) && !group.archived_at),
    )
    .map((group) => ({
      id: group.id,
      name: group.name,
      code: group.code,
      archived: group.archived_at !== null,
      role: roles.get(group.id) ?? null,
      canManage: user.is_admin === 1 || roles.get(group.id) === "manager",
      // Postgres returns counts as strings.
      members: Number(
        counts.find((c) => c.group_id === group.id)?.members ?? 0,
      ),
    }));
}

export async function createGroup(ctx: Ctx, caller: Caller, raw: unknown) {
  requireAdmin(caller);
  const parsed = groupInput.safeParse(raw);
  if (!parsed.success)
    throw badRequest("Check the details and try again.", parsed.error.issues);
  const row: GroupsTable = {
    id: newId(),
    name: parsed.data.name,
    code: parsed.data.code,
    created_at: ctx.now(),
    archived_at: null,
  };
  await ctx.store.atomic([
    ctx.db.insertInto("groups").values(row),
    audit(ctx, caller, "group.create", "group", row.id, {
      name: row.name,
      code: row.code,
    }),
  ]);
  return { id: row.id };
}

export async function updateGroup(
  ctx: Ctx,
  caller: Caller,
  groupId: string,
  raw: unknown,
) {
  await requireGroupManager(ctx, caller, groupId);
  // Not `groupInput.partial()`: that fills `code` in as null whenever a patch
  // leaves it out, so archiving a group would erase its number.
  const parsed = z
    .object({
      name: groupInput.shape.name.optional(),
      code: z
        .string()
        .trim()
        .max(40)
        .nullable()
        .optional()
        .transform((code) => (code === undefined ? undefined : code || null)),
      archived: z.boolean().optional(),
    })
    .safeParse(raw);
  if (!parsed.success)
    throw badRequest("Check the details and try again.", parsed.error.issues);
  const patch = parsed.data;
  await ctx.store.atomic([
    ctx.db
      .updateTable("groups")
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.code !== undefined && { code: patch.code }),
        ...(patch.archived !== undefined && {
          archived_at: patch.archived ? ctx.now() : null,
        }),
      })
      .where("id", "=", groupId),
    audit(ctx, caller, "group.update", "group", groupId, patch),
  ]);
}

/** The manager's view: every member with where they stand on each clearance. */
export async function getGroup(ctx: Ctx, caller: Caller, groupId: string) {
  const { group } = await requireGroupManager(ctx, caller, groupId);
  const settings = await getSettings(ctx);
  const now = ctx.now();

  const rows = await ctx.db
    .selectFrom("group_members")
    .innerJoin("users", "users.id", "group_members.user_id")
    .selectAll("users")
    .select(["group_members.role", "group_members.joined_at"])
    .where("group_members.group_id", "=", groupId)
    .orderBy("users.name")
    .execute();
  const [summaries, statuses, invites, guardians] = await Promise.all([
    summarise(ctx, settings, rows),
    statusesFor(ctx, settings, rows),
    ctx.db
      .selectFrom("invites")
      .selectAll()
      .where("group_id", "=", groupId)
      .where("revoked_at", "is", null)
      .orderBy("created_at", "desc")
      .execute(),
    rows.length
      ? ctx.db
          .selectFrom("guardianships")
          .innerJoin("users", "users.id", "guardianships.guardian_id")
          .select([
            "guardianships.id",
            "guardianships.ward_id",
            "guardianships.verified_at",
            "users.id as guardian_id",
            "users.name as guardian_name",
          ])
          .where(
            "guardianships.ward_id",
            "in",
            rows.map((row) => row.id),
          )
          .execute()
      : [],
  ]);

  return {
    id: group.id,
    name: group.name,
    code: group.code,
    archived: group.archived_at !== null,
    members: rows.map((row, index) => ({
      ...summaries[index]!,
      role: row.role,
      joinedAt: row.joined_at,
      clearances: statuses.get(row.id) ?? [],
      guardians: guardians
        .filter((g) => g.ward_id === row.id)
        .map((g) => ({
          guardianshipId: g.id,
          id: g.guardian_id,
          name: g.guardian_name,
          verified: g.verified_at !== null,
        })),
    })),
    invites: invites
      .filter((invite) => !inviteProblem(invite, now))
      .map((invite) => ({
        id: invite.id,
        kind: invite.kind,
        token: invite.token,
        expiresAt: invite.expires_at,
        maxUses: invite.max_uses,
        uses: invite.uses,
        createdAt: invite.created_at,
      })),
  };
}

export const groupInviteInput = z.object({
  kind: z.enum(["group_member", "group_manager"]),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(null),
  maxUses: z.number().int().min(1).max(10_000).nullable().default(null),
});

export async function createGroupInvite(
  ctx: Ctx,
  caller: Caller,
  groupId: string,
  raw: unknown,
) {
  const { user } = await requireGroupManager(ctx, caller, groupId);
  const parsed = groupInviteInput.safeParse(raw);
  if (!parsed.success)
    throw badRequest("Check the details and try again.", parsed.error.issues);
  const { row, token, query } = await createInvite(ctx, {
    kind: parsed.data.kind,
    createdBy: user.id,
    groupId,
    expiresAt: parsed.data.expiresInDays
      ? addDays(ctx.now(), parsed.data.expiresInDays)
      : null,
    maxUses: parsed.data.maxUses,
  });
  await ctx.store.atomic([
    query,
    audit(ctx, caller, "invite.create", "group", groupId, {
      invite: row.id,
      kind: row.kind,
    }),
  ]);
  return { id: row.id, token };
}

export async function revokeInvite(ctx: Ctx, caller: Caller, inviteId: string) {
  const user = requireUser(caller);
  const invite = await ctx.db
    .selectFrom("invites")
    .selectAll()
    .where("id", "=", inviteId)
    .executeTakeFirst();
  if (!invite) throw notFound("That link does not exist.");
  if (invite.group_id) await requireGroupManager(ctx, caller, invite.group_id);
  else if (invite.created_by !== user.id && !user.is_admin) throw forbidden();
  await ctx.store.atomic([
    ctx.db
      .updateTable("invites")
      .set({ revoked_at: ctx.now() })
      .where("id", "=", inviteId),
    audit(ctx, caller, "invite.revoke", "invite", inviteId),
  ]);
}

export async function setMemberRole(
  ctx: Ctx,
  caller: Caller,
  groupId: string,
  userId: string,
  role: unknown,
) {
  await requireGroupManager(ctx, caller, groupId);
  if (role !== "manager" && role !== "member")
    throw badRequest("Unknown role.");
  if (role === "manager") {
    const settings = await getSettings(ctx);
    if (isMinor(await getUser(ctx, userId), settings, ctx.now())) {
      throw badRequest("A minor cannot manage a group.");
    }
  }
  const result = await ctx.db
    .updateTable("group_members")
    .set({ role })
    .where("group_id", "=", groupId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n)
    throw notFound("That person is not in this group.");
  await audit(ctx, caller, "group.role", "group", groupId, {
    user: userId,
    role,
  }).execute();
}

export async function removeMember(
  ctx: Ctx,
  caller: Caller,
  groupId: string,
  userId: string,
) {
  await requireGroupManager(ctx, caller, groupId);
  await ctx.store.atomic([
    ctx.db
      .deleteFrom("group_members")
      .where("group_id", "=", groupId)
      .where("user_id", "=", userId),
    audit(ctx, caller, "group.remove_member", "group", groupId, {
      user: userId,
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Links, from the side of the person who opened one

/** Safe to show to someone who is not signed in: it is what the link says. */
export async function describeInvite(ctx: Ctx, token: string) {
  const invite = await findInvite(ctx, token);
  const [group, target, inviter] = await Promise.all([
    invite.group_id
      ? ctx.db
          .selectFrom("groups")
          .select(["name", "code"])
          .where("id", "=", invite.group_id)
          .executeTakeFirst()
      : undefined,
    invite.target_user_id ? getUser(ctx, invite.target_user_id) : undefined,
    getUser(ctx, invite.created_by),
  ]);
  return {
    kind: invite.kind,
    group: group ?? null,
    targetName: target?.name ?? null,
    inviterName: inviter.name,
  };
}

/** Someone who already has an account opens a link. */
export async function acceptInvite(ctx: Ctx, caller: Caller, token: string) {
  const user = requireUser(caller);
  const invite = await findInvite(ctx, token);
  const settings = await getSettings(ctx);

  if (invite.kind === "claim" || invite.kind === "passkey") {
    throw badRequest(
      "This link adds a passkey. Sign out first, then open it again.",
    );
  }
  if (invite.kind === "guardian") {
    if (!guardianship(settings))
      throw badRequest("Guardian support is turned off.");
    if (invite.target_user_id === user.id)
      throw badRequest("You cannot be your own guardian.");
    if (isMinor(user, settings, ctx.now()))
      throw forbidden("A guardian has to be an adult.");
  }
  if (invite.kind === "group_manager" && isMinor(user, settings, ctx.now())) {
    throw forbidden("A minor cannot manage a group.");
  }
  if (
    invite.kind === "group_member" &&
    (await roleIn(ctx, invite.group_id!, user.id))
  ) {
    throw conflict("You are already in this group.");
  }

  await consumeInvite(ctx, invite.id);
  await ctx.store.atomic([
    ...inviteEffect(ctx, invite, user.id),
    audit(ctx, caller, "invite.accept", "invite", invite.id, {
      kind: invite.kind,
    }),
  ]);
  return {
    kind: invite.kind,
    groupId: invite.group_id,
    wardId: invite.target_user_id,
  };
}
