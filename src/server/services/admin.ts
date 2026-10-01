import { z } from "zod";
import {
  badRequest,
  type Caller,
  conflict,
  type Ctx,
  requireAdmin,
  requireUser,
} from "../context.ts";
import { addDays } from "../lib/util.ts";
import { audit } from "./audit.ts";
import { statusesFor } from "./clearances.ts";
import { createInvite } from "./invites.ts";
import { getUser, relationTo, summarise } from "./people.ts";
import { getSettings } from "./settings.ts";

export async function listUsers(ctx: Ctx, caller: Caller) {
  requireAdmin(caller);
  const settings = await getSettings(ctx);
  const [users, passkeys] = await Promise.all([
    ctx.db.selectFrom("users").selectAll().orderBy("name").execute(),
    ctx.db
      .selectFrom("credentials")
      .select((eb) => ["user_id", eb.fn.countAll().as("count")])
      .groupBy("user_id")
      .execute(),
  ]);
  const summaries = await summarise(ctx, settings, users);
  return users.map((user, index) => ({
    ...summaries[index]!,
    admin: user.is_admin === 1,
    disabled: user.disabled_at !== null,
    createdAt: user.created_at,
    passkeys: Number(passkeys.find((p) => p.user_id === user.id)?.count ?? 0),
  }));
}

export const userPatch = z.object({
  admin: z.boolean().optional(),
  disabled: z.boolean().optional(),
});

export async function updateUser(
  ctx: Ctx,
  caller: Caller,
  userId: string,
  raw: unknown,
) {
  const admin = requireAdmin(caller);
  const parsed = userPatch.safeParse(raw);
  if (!parsed.success) throw badRequest("Check the details and try again.");
  const patch = parsed.data;
  // An admin cannot lock themself out; another admin has to do it.
  if (
    userId === admin.id &&
    (patch.admin === false || patch.disabled === true)
  ) {
    throw conflict("Ask another administrator to change your own access.");
  }
  await getUser(ctx, userId);
  await ctx.store.atomic([
    ctx.db
      .updateTable("users")
      .set({
        ...(patch.admin !== undefined && { is_admin: patch.admin ? 1 : 0 }),
        ...(patch.disabled !== undefined && {
          disabled_at: patch.disabled ? ctx.now() : null,
        }),
      })
      .where("id", "=", userId),
    // Turning an account off also ends its sign-ins.
    ...(patch.disabled
      ? [ctx.db.deleteFrom("sessions").where("user_id", "=", userId)]
      : []),
    audit(ctx, caller, "user.update", "user", userId, patch),
  ]);
}

/**
 * The recovery path for a lost passkey. With no passwords and no email, the
 * only way back in is an administrator handing over a one-time link. Group
 * managers cannot do this: whoever holds the link can sign as that person.
 */
export async function passkeyInvite(ctx: Ctx, caller: Caller, userId: string) {
  const actor = requireAdmin(caller);
  await getUser(ctx, userId);
  const { row, token, query } = await createInvite(ctx, {
    kind: "passkey",
    createdBy: actor.id,
    targetUserId: userId,
    expiresAt: addDays(ctx.now(), 2),
    maxUses: 1,
  });
  await ctx.store.atomic([
    query,
    audit(ctx, caller, "invite.create", "user", userId, {
      invite: row.id,
      kind: "passkey",
    }),
  ]);
  return { token, expiresAt: row.expires_at };
}

/** One person's clearances and signed records, for whoever is entitled to see them. */
export async function getPerson(ctx: Ctx, caller: Caller, userId: string) {
  requireUser(caller);
  const relation = await relationTo(ctx, caller, userId);
  const settings = await getSettings(ctx);
  const user = await getUser(ctx, userId);
  const [[summary], statuses, signatures] = await Promise.all([
    summarise(ctx, settings, [user]),
    statusesFor(ctx, settings, [user]),
    ctx.db
      .selectFrom("signatures")
      .innerJoin("users as signer", "signer.id", "signatures.signer_id")
      .innerJoin(
        "document_versions",
        "document_versions.id",
        "signatures.document_version_id",
      )
      .select([
        "signatures.id",
        "signatures.clearance_id",
        "signatures.capacity",
        "signatures.signed_at",
        "signer.name as signer_name",
        "document_versions.title",
        "document_versions.version",
      ])
      .where("signatures.subject_id", "=", userId)
      .orderBy("signatures.signed_at", "desc")
      .execute(),
  ]);
  return {
    ...summary!,
    relation,
    clearances: statuses.get(userId) ?? [],
    signatures: signatures.map((s) => ({
      id: s.id,
      clearanceId: s.clearance_id,
      capacity: s.capacity,
      signedAt: s.signed_at,
      signerName: s.signer_name,
      title: s.title,
      version: s.version,
    })),
  };
}
