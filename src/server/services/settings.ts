import {
  DEFAULT_SETTINGS,
  type Settings,
  settingsSchema,
} from "../../shared/settings.ts";
import { badRequest, type Caller, type Ctx, requireAdmin } from "../context.ts";
import { audit } from "./audit.ts";

export async function getSettings(ctx: Ctx): Promise<Settings> {
  const rows = await ctx.db
    .selectFrom("settings")
    .select(["key", "value"])
    .execute();
  const stored: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.key in DEFAULT_SETTINGS) stored[row.key] = JSON.parse(row.value);
  }
  return { ...DEFAULT_SETTINGS, ...stored } as Settings;
}

/** One upsert per key, as queries, so callers can fold them into an atomic batch. */
export function settingQueries(
  ctx: Ctx,
  values: Partial<Settings>,
  updatedBy: string | null,
) {
  const at = ctx.now();
  return Object.entries(values).map(([key, value]) =>
    ctx.db
      .insertInto("settings")
      .values({
        key,
        value: JSON.stringify(value),
        updated_at: at,
        updated_by: updatedBy,
      })
      .onConflict((oc) =>
        oc
          .column("key")
          .doUpdateSet({
            value: JSON.stringify(value),
            updated_at: at,
            updated_by: updatedBy,
          }),
      ),
  );
}

export async function updateSettings(
  ctx: Ctx,
  caller: Caller,
  patch: unknown,
): Promise<Settings> {
  const admin = requireAdmin(caller);
  const parsed = settingsSchema.partial().safeParse(patch);
  if (!parsed.success)
    throw badRequest("Some settings are not valid.", parsed.error.issues);
  if (parsed.data.origin === null)
    throw badRequest("The site address cannot be cleared.");

  await ctx.store.atomic([
    ...settingQueries(ctx, parsed.data, admin.id),
    audit(ctx, caller, "settings.update", "settings", "site", parsed.data),
  ]);
  return getSettings(ctx);
}

/** The WebAuthn relying-party ID is the hostname passkeys are bound to. */
export function rpIdOf(origin: string): string {
  return new URL(origin).hostname;
}
