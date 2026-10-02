import type { Compilable } from "kysely";
import { z } from "zod";
import {
  badRequest,
  type Caller,
  type Ctx,
  forbidden,
  notFound,
  requireUser,
} from "../context.ts";
import type { InvitesTable, UsersTable } from "../db/schema.ts";
import { addDays, ageOn, newId } from "../lib/util.ts";
import { audit } from "./audit.ts";
import { inviteEffect } from "./auth.ts";
import { statusesFor } from "./clearances.ts";
import { consumeInvite, createInvite, findInvite } from "./invites.ts";
import {
  isGuardianOf,
  isMinor,
  requireOversight,
  summarise,
} from "./people.ts";
import { guardianship } from "../../shared/settings.ts";
import { getSettings } from "./settings.ts";

// Guardianship is a relationship between two ordinary accounts. A guardian may
// also be a participant, and a child may start as a "managed" account with no
// passkey that the guardian runs until the child claims it.

async function requireGuardians(ctx: Ctx) {
  const settings = await getSettings(ctx);
  if (!guardianship(settings))
    throw badRequest("Guardian support is turned off on this site.");
  return settings;
}

/** The caller, the children they are guardian of, and their own guardians. */
export async function getFamily(ctx: Ctx, caller: Caller) {
  const user = requireUser(caller);
  const settings = await getSettings(ctx);
  const [wardRows, guardianRows] = await Promise.all([
    ctx.db
      .selectFrom("guardianships")
      .innerJoin("users", "users.id", "guardianships.ward_id")
      .selectAll("users")
      .select([
        "guardianships.id as guardianship_id",
        "guardianships.verified_at",
      ])
      .where("guardianships.guardian_id", "=", user.id)
      .orderBy("users.name")
      .execute(),
    ctx.db
      .selectFrom("guardianships")
      .innerJoin("users", "users.id", "guardianships.guardian_id")
      .select(["users.id", "users.name", "guardianships.verified_at"])
      .where("guardianships.ward_id", "=", user.id)
      .execute(),
  ]);

  const people: UsersTable[] = [user, ...wardRows];
  const [summaries, statuses] = await Promise.all([
    summarise(ctx, settings, people),
    statusesFor(ctx, settings, people),
  ]);
  const [me, ...wards] = summaries.map((summary) => ({
    ...summary,
    clearances: statuses.get(summary.id) ?? [],
  }));

  return {
    guardiansEnabled: guardianship(settings),
    me: me!,
    wards: wards.map((ward, index) => ({
      ...ward,
      birthdate: wardRows[index]!.birthdate,
    })),
    guardians: guardianRows.map((row) => ({
      id: row.id,
      name: row.name,
      verified: row.verified_at !== null,
    })),
  };
}

export const wardInput = z.object({
  name: z.string().trim().min(1).max(100),
  birthdate: z.iso.date(),
  /** A group link: the child joins that group. */
  invite: z.string().min(1).optional(),
});

/** A parent adds a child, who gets an account the parent runs. */
export async function addWard(ctx: Ctx, caller: Caller, raw: unknown) {
  const guardian = requireUser(caller);
  const settings = await requireGuardians(ctx);
  const parsed = wardInput.safeParse(raw);
  if (!parsed.success)
    throw badRequest("Check the details and try again.", parsed.error.issues);
  const now = ctx.now();
  if (isMinor(guardian, settings, now))
    throw forbidden("A guardian has to be an adult.");
  const age = ageOn(parsed.data.birthdate, now);
  if (age < 0) throw badRequest("That date of birth is in the future.");
  if (age >= settings.adultAge) {
    throw badRequest(
      `Someone aged ${settings.adultAge} or over signs for themself and needs their own account.`,
    );
  }

  let invite: InvitesTable | null = null;
  if (parsed.data.invite) {
    invite = await findInvite(ctx, parsed.data.invite);
    if (invite.kind !== "group_member")
      throw badRequest("That link is not a group link.");
    await consumeInvite(ctx, invite.id);
  }

  const wardId = newId();
  const queries: Compilable[] = [
    ctx.db.insertInto("users").values({
      id: wardId,
      name: parsed.data.name,
      birthdate: parsed.data.birthdate,
      is_admin: 0,
      managed: 1,
      created_at: now,
      disabled_at: null,
    }),
    ctx.db.insertInto("guardianships").values({
      id: newId(),
      guardian_id: guardian.id,
      ward_id: wardId,
      created_at: now,
      verified_at: null,
      verified_by: null,
    }),
    audit(ctx, caller, "ward.create", "user", wardId, {
      invite: invite?.id ?? null,
    }),
  ];
  if (invite) queries.push(...inviteEffect(ctx, invite, wardId));
  await ctx.store.atomic(queries);
  return { id: wardId };
}

/** A link the child opens to put their own passkey on their account. */
export async function wardClaimInvite(
  ctx: Ctx,
  caller: Caller,
  wardId: string,
) {
  const guardian = requireUser(caller);
  if (!(await isGuardianOf(ctx, guardian.id, wardId))) throw forbidden();
  const { row, token, query } = await createInvite(ctx, {
    kind: "claim",
    createdBy: guardian.id,
    targetUserId: wardId,
    expiresAt: addDays(ctx.now(), 7),
    maxUses: 1,
  });
  await ctx.store.atomic([
    query,
    audit(ctx, caller, "invite.create", "user", wardId, {
      invite: row.id,
      kind: "claim",
    }),
  ]);
  return { token, expiresAt: row.expires_at };
}

/** A link a minor sends to a parent, who becomes their guardian by opening it. */
export async function guardianInvite(ctx: Ctx, caller: Caller) {
  const user = requireUser(caller);
  const settings = await requireGuardians(ctx);
  if (!isMinor(user, settings, ctx.now())) {
    throw badRequest("Only someone under the adult age needs a guardian.");
  }
  const { row, token, query } = await createInvite(ctx, {
    kind: "guardian",
    createdBy: user.id,
    targetUserId: user.id,
    expiresAt: addDays(ctx.now(), 30),
    maxUses: 4,
  });
  await ctx.store.atomic([
    query,
    audit(ctx, caller, "invite.create", "user", user.id, {
      invite: row.id,
      kind: "guardian",
    }),
  ]);
  return { token, expiresAt: row.expires_at };
}

/**
 * A manager records that they have checked a guardian is who they claim to
 * be. Nothing online can prove parenthood; this is the human check.
 */
export async function verifyGuardianship(
  ctx: Ctx,
  caller: Caller,
  guardianshipId: string,
  verified: boolean,
) {
  const row = await ctx.db
    .selectFrom("guardianships")
    .selectAll()
    .where("id", "=", guardianshipId)
    .executeTakeFirst();
  if (!row) throw notFound("That relationship does not exist.");
  const actor = await requireOversight(ctx, caller, row.ward_id);
  await ctx.store.atomic([
    ctx.db
      .updateTable("guardianships")
      .set({
        verified_at: verified ? ctx.now() : null,
        verified_by: verified ? actor.id : null,
      })
      .where("id", "=", guardianshipId),
    audit(
      ctx,
      caller,
      verified ? "guardian.verify" : "guardian.unverify",
      "user",
      row.ward_id,
      {
        guardian: row.guardian_id,
      },
    ),
  ]);
}

export async function removeGuardianship(
  ctx: Ctx,
  caller: Caller,
  guardianshipId: string,
) {
  const row = await ctx.db
    .selectFrom("guardianships")
    .selectAll()
    .where("id", "=", guardianshipId)
    .executeTakeFirst();
  if (!row) throw notFound("That relationship does not exist.");
  await requireOversight(ctx, caller, row.ward_id);
  await ctx.store.atomic([
    ctx.db.deleteFrom("guardianships").where("id", "=", guardianshipId),
    audit(ctx, caller, "guardian.remove", "user", row.ward_id, {
      guardian: row.guardian_id,
    }),
  ]);
}
