import { type Ctx, gone } from "../context.ts";
import type { InviteKind, InvitesTable } from "../db/schema.ts";
import { newId, randomToken, sha256Hex } from "../lib/util.ts";

// An invite is a link. It is the only way an account comes to exist after the
// first administrator, and the only way a passkey is added to an account that
// is not currently signed in.

export interface NewInvite {
  kind: InviteKind;
  createdBy: string;
  groupId?: string;
  targetUserId?: string;
  expiresAt?: string | null;
  maxUses?: number | null;
}

/** Group links are shown again later, so only those keep the token readable. */
const REDISPLAYABLE: InviteKind[] = ["group_member", "group_manager"];

export async function createInvite(ctx: Ctx, invite: NewInvite) {
  const token = randomToken();
  const row: InvitesTable = {
    id: newId(),
    token_hash: await sha256Hex(token),
    token: REDISPLAYABLE.includes(invite.kind) ? token : null,
    kind: invite.kind,
    group_id: invite.groupId ?? null,
    target_user_id: invite.targetUserId ?? null,
    created_by: invite.createdBy,
    created_at: ctx.now(),
    expires_at: invite.expiresAt ?? null,
    max_uses: invite.maxUses ?? null,
    uses: 0,
    revoked_at: null,
  };
  return { row, token, query: ctx.db.insertInto("invites").values(row) };
}

export function inviteProblem(
  invite: InvitesTable,
  now: string,
): string | null {
  if (invite.revoked_at) return "This link has been turned off.";
  if (invite.expires_at && invite.expires_at <= now)
    return "This link has expired.";
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) {
    return "This link has already been used.";
  }
  return null;
}

/** The invite behind a token, or a 410 explaining why the link is dead. */
export async function findInvite(
  ctx: Ctx,
  token: string,
): Promise<InvitesTable> {
  const invite = await ctx.db
    .selectFrom("invites")
    .selectAll()
    .where("token_hash", "=", await sha256Hex(token))
    .executeTakeFirst();
  if (!invite) throw gone("This link is not valid.");
  const problem = inviteProblem(invite, ctx.now());
  if (problem) throw gone(problem);
  return invite;
}

/**
 * Takes one use. The limit is enforced by the UPDATE's own WHERE clause, so
 * two people racing for the last use cannot both get it.
 */
export async function consumeInvite(ctx: Ctx, inviteId: string): Promise<void> {
  const now = ctx.now();
  const result = await ctx.db
    .updateTable("invites")
    .set((eb) => ({ uses: eb("uses", "+", 1) }))
    .where("id", "=", inviteId)
    .where("revoked_at", "is", null)
    .where((eb) =>
      eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]),
    )
    .where((eb) =>
      eb.or([eb("max_uses", "is", null), eb("uses", "<", eb.ref("max_uses"))]),
    )
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n)
    throw gone("This link can no longer be used.");
}
