import type { Settings } from "../../shared/settings.ts";
import {
  type Caller,
  type Ctx,
  forbidden,
  notFound,
  requireUser,
} from "../context.ts";
import type { UsersTable } from "../db/schema.ts";
import { ageOn } from "../lib/util.ts";

/** Minors only exist as a concept when guardian support is switched on. */
export function isMinor(
  user: Pick<UsersTable, "birthdate">,
  settings: Settings,
  now: string,
) {
  if (!settings.guardiansEnabled || !user.birthdate) return false;
  return ageOn(user.birthdate, now) < settings.adultAge;
}

export async function getUser(ctx: Ctx, id: string): Promise<UsersTable> {
  const user = await ctx.db
    .selectFrom("users")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!user) throw notFound("That person does not exist.");
  return user;
}

export async function isGuardianOf(
  ctx: Ctx,
  guardianId: string,
  wardId: string,
) {
  const row = await ctx.db
    .selectFrom("guardianships")
    .select("id")
    .where("guardian_id", "=", guardianId)
    .where("ward_id", "=", wardId)
    .executeTakeFirst();
  return Boolean(row);
}

/** True when `managerId` manages at least one group that `subjectId` belongs to. */
export async function managesPerson(
  ctx: Ctx,
  managerId: string,
  subjectId: string,
) {
  const row = await ctx.db
    .selectFrom("group_members as mine")
    .innerJoin("group_members as theirs", "theirs.group_id", "mine.group_id")
    .select("mine.group_id")
    .where("mine.user_id", "=", managerId)
    .where("mine.role", "=", "manager")
    .where("theirs.user_id", "=", subjectId)
    .executeTakeFirst();
  return Boolean(row);
}

export type Relation = "self" | "guardian" | "manager" | "admin";

/**
 * How the caller is entitled to see a person's records, or a 403. The most
 * personal relation wins, so a guardian who is also an admin is a guardian.
 */
export async function relationTo(
  ctx: Ctx,
  caller: Caller,
  subjectId: string,
): Promise<Relation> {
  const user = requireUser(caller);
  if (user.id === subjectId) return "self";
  if (await isGuardianOf(ctx, user.id, subjectId)) return "guardian";
  if (await managesPerson(ctx, user.id, subjectId)) return "manager";
  if (user.is_admin) return "admin";
  throw forbidden("You are not connected to that person.");
}

/** Managers and admins may act on a person's records; family may only view. */
export async function requireOversight(
  ctx: Ctx,
  caller: Caller,
  subjectId: string,
) {
  const user = requireUser(caller);
  if (user.is_admin) return user;
  if (await managesPerson(ctx, user.id, subjectId)) return user;
  throw forbidden("Only a manager of one of this person's groups can do that.");
}

export interface PersonSummary {
  id: string;
  name: string;
  minor: boolean;
  /** No passkey of their own yet; a guardian runs the account. */
  managed: boolean;
  /** A minor with no guardian linked, who therefore cannot be cleared. */
  needsGuardian: boolean;
}

export async function summarise(
  ctx: Ctx,
  settings: Settings,
  users: UsersTable[],
): Promise<PersonSummary[]> {
  const now = ctx.now();
  const minors = users.filter((user) => isMinor(user, settings, now));
  const guarded = new Set<string>();
  if (minors.length) {
    const rows = await ctx.db
      .selectFrom("guardianships")
      .select("ward_id")
      .where(
        "ward_id",
        "in",
        minors.map((user) => user.id),
      )
      .execute();
    for (const row of rows) guarded.add(row.ward_id);
  }
  return users.map((user) => {
    const minor = isMinor(user, settings, now);
    return {
      id: user.id,
      name: user.name,
      minor,
      managed: user.managed === 1,
      needsGuardian: minor && !guarded.has(user.id),
    };
  });
}
