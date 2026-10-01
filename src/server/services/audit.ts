import type { Caller, Ctx } from "../context.ts";
import { requireAdmin } from "../context.ts";
import { newId } from "../lib/util.ts";

/**
 * An audit entry as an insert query. It is returned, not executed, so that it
 * can ride in the same atomic batch as the change it describes.
 */
export function audit(
  ctx: Ctx,
  caller: Caller,
  action: string,
  subjectType: string,
  subjectId: string,
  detail: unknown = {},
  actorId: string | null = caller.user?.id ?? null,
) {
  return ctx.db.insertInto("audit_log").values({
    id: newId(),
    at: ctx.now(),
    actor_id: actorId,
    action,
    subject_type: subjectType,
    subject_id: subjectId,
    detail: JSON.stringify(detail),
    ip: caller.ip,
  });
}

export async function listAudit(ctx: Ctx, caller: Caller, limit = 200) {
  requireAdmin(caller);
  const rows = await ctx.db
    .selectFrom("audit_log")
    .leftJoin("users", "users.id", "audit_log.actor_id")
    .select([
      "audit_log.id",
      "audit_log.at",
      "audit_log.action",
      "audit_log.subject_type",
      "audit_log.subject_id",
      "audit_log.detail",
      "audit_log.ip",
      "users.name as actor_name",
    ])
    .orderBy("audit_log.at", "desc")
    .limit(Math.min(limit, 1000))
    .execute();
  return rows.map((row) => ({
    ...row,
    detail: JSON.parse(row.detail) as unknown,
  }));
}
