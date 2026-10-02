import type { Compilable } from "kysely";
import {
  type ConfigChange,
  type ConfigDocument,
  type ConfigGroup,
  configSchema,
  isApplied,
  type SiteConfig,
} from "../../shared/config.ts";
import type { Settings } from "../../shared/settings.ts";
import { badRequest, type Caller, type Ctx, requireAdmin } from "../context.ts";
import type { ClearancesTable, GroupsTable } from "../db/schema.ts";
import { newId } from "../lib/util.ts";
import { audit } from "./audit.ts";
import { getSettings, settingQueries } from "./settings.ts";

// Export the site's configuration as a file, and apply a file back. Applying
// is always previewed first: `planConfig` and `applyConfig` compute the same
// list of changes, and only the second one writes.

interface DocumentState {
  row: ClearancesTable;
  published: { version: number; fingerprint: string } | null;
}

async function documents(ctx: Ctx): Promise<DocumentState[]> {
  const [rows, versions] = await Promise.all([
    ctx.db.selectFrom("clearances").selectAll().orderBy("name").execute(),
    ctx.db
      .selectFrom("document_versions")
      .select(["clearance_id", "version", "body_hash"])
      .orderBy("version")
      .execute(),
  ]);
  return rows.map((row) => {
    const latest = versions.filter((v) => v.clearance_id === row.id).at(-1);
    return {
      row,
      published: latest
        ? { version: latest.version, fingerprint: latest.body_hash }
        : null,
    };
  });
}

function describe(state: DocumentState): ConfigDocument {
  return {
    name: state.row.name,
    description: state.row.description,
    requiredForAll: state.row.required_for_all === 1,
    validityDays: state.row.validity_days,
    minorPolicy: state.row.minor_policy,
    archived: state.row.archived_at !== null,
    published: state.published,
  };
}

function groups(ctx: Ctx): Promise<GroupsTable[]> {
  return ctx.db.selectFrom("groups").selectAll().orderBy("name").execute();
}

function describeGroup(row: GroupsTable): ConfigGroup {
  return { name: row.name, code: row.code, archived: row.archived_at !== null };
}

export async function exportConfig(
  ctx: Ctx,
  caller: Caller,
): Promise<SiteConfig> {
  requireAdmin(caller);
  return currentConfig(ctx);
}

/** Without the permission check, for the command line. */
export async function currentConfig(ctx: Ctx): Promise<SiteConfig> {
  const { origin: _deployment, ...settings } = await getSettings(ctx);
  return {
    clearanceConfig: 1,
    settings,
    documents: (await documents(ctx)).map(describe),
    groups: (await groups(ctx)).map(describeGroup),
  };
}

function parse(raw: unknown): SiteConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw badRequest(
      `This is not a valid configuration file: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim(),
      parsed.error.issues,
    );
  }
  for (const list of [parsed.data.documents, parsed.data.groups]) {
    const names = list.map((entry) => entry.name);
    const repeated = names.find((name, index) => names.indexOf(name) !== index);
    if (repeated) {
      throw badRequest(`The configuration lists "${repeated}" more than once.`);
    }
  }
  return parsed.data;
}

const RULES = [
  "description",
  "requiredForAll",
  "validityDays",
  "minorPolicy",
  "archived",
] as const;

async function diff(ctx: Ctx, config: SiteConfig) {
  const changes: ConfigChange[] = [];
  const settings = await getSettings(ctx);
  for (const [key, to] of Object.entries(config.settings)) {
    const from = settings[key as keyof Settings];
    if (from !== to) changes.push({ kind: "setting", key, from, to });
  }

  const existing = await documents(ctx);
  for (const wanted of config.documents) {
    const state = existing.find((entry) => entry.row.name === wanted.name);
    if (!state) {
      changes.push({ kind: "document.create", name: wanted.name });
    } else {
      const have = describe(state);
      for (const field of RULES) {
        if (have[field] !== wanted[field]) {
          changes.push({
            kind: "document.update",
            name: wanted.name,
            field,
            from: have[field],
            to: wanted[field],
          });
        }
      }
    }
    const published = state?.published?.fingerprint ?? null;
    if (wanted.published && wanted.published.fingerprint !== published) {
      changes.push({
        kind: "document.text",
        name: wanted.name,
        published,
        expected: wanted.published.fingerprint,
      });
    }
  }
  for (const state of existing) {
    if (!config.documents.some((wanted) => wanted.name === state.row.name)) {
      changes.push({ kind: "document.unlisted", name: state.row.name });
    }
  }

  const existingGroups = await groups(ctx);
  for (const wanted of config.groups) {
    const row = existingGroups.find((entry) => entry.name === wanted.name);
    if (!row) {
      changes.push({ kind: "group.create", name: wanted.name });
      continue;
    }
    const have = describeGroup(row);
    for (const field of ["code", "archived"] as const) {
      if (have[field] !== wanted[field]) {
        changes.push({
          kind: "group.update",
          name: wanted.name,
          field,
          from: have[field],
          to: wanted[field],
        });
      }
    }
  }
  for (const row of existingGroups) {
    if (!config.groups.some((wanted) => wanted.name === row.name)) {
      changes.push({ kind: "group.unlisted", name: row.name });
    }
  }
  return { changes, existing, existingGroups };
}

/** What applying this configuration would do, without doing it. */
export async function planConfig(ctx: Ctx, caller: Caller, raw: unknown) {
  requireAdmin(caller);
  return { changes: (await diff(ctx, parse(raw))).changes };
}

/** The same preview, for the command line. */
export async function previewConfig(ctx: Ctx, raw: unknown) {
  return (await diff(ctx, parse(raw))).changes;
}

export async function applyConfig(ctx: Ctx, caller: Caller, raw: unknown) {
  const admin = requireAdmin(caller);
  return applyParsed(ctx, caller, parse(raw), admin.id);
}

/** For the command line, where there is no signed-in administrator. */
export async function applyConfigUnattended(ctx: Ctx, raw: unknown) {
  const caller: Caller = {
    user: null,
    ip: "",
    userAgent: "clearance config apply",
    origin: null,
  };
  return applyParsed(ctx, caller, parse(raw), null);
}

async function applyParsed(
  ctx: Ctx,
  caller: Caller,
  config: SiteConfig,
  actorId: string | null,
) {
  const { changes, existing, existingGroups } = await diff(ctx, config);
  const now = ctx.now();
  const queries: Compilable[] = [];

  const settings: Record<string, unknown> = {};
  for (const change of changes) {
    if (change.kind === "setting") settings[change.key] = change.to;
  }
  queries.push(...settingQueries(ctx, settings as Partial<Settings>, actorId));

  for (const wanted of config.documents) {
    const state = existing.find((entry) => entry.row.name === wanted.name);
    const values = {
      description: wanted.description,
      required_for_all: (wanted.requiredForAll ? 1 : 0) as 0 | 1,
      validity_days: wanted.validityDays,
      minor_policy: wanted.minorPolicy,
    };
    if (!state) {
      queries.push(
        ctx.db.insertInto("clearances").values({
          id: newId(),
          name: wanted.name,
          kind: "release",
          created_at: now,
          archived_at: wanted.archived ? now : null,
          ...values,
        }),
      );
    } else if (
      changes.some(
        (change) =>
          change.kind === "document.update" && change.name === wanted.name,
      )
    ) {
      queries.push(
        ctx.db
          .updateTable("clearances")
          .set({
            ...values,
            // Keep the original archive date when it was already archived.
            archived_at: wanted.archived
              ? (state.row.archived_at ?? now)
              : null,
          })
          .where("id", "=", state.row.id),
      );
    }
  }

  for (const wanted of config.groups) {
    const row = existingGroups.find((entry) => entry.name === wanted.name);
    if (!row) {
      queries.push(
        ctx.db.insertInto("groups").values({
          id: newId(),
          name: wanted.name,
          code: wanted.code,
          created_at: now,
          archived_at: wanted.archived ? now : null,
        }),
      );
    } else if (
      changes.some(
        (change) =>
          change.kind === "group.update" && change.name === wanted.name,
      )
    ) {
      queries.push(
        ctx.db
          .updateTable("groups")
          .set({
            code: wanted.code,
            archived_at: wanted.archived ? (row.archived_at ?? now) : null,
          })
          .where("id", "=", row.id),
      );
    }
  }

  const applied = changes.filter(isApplied);
  if (applied.length) {
    queries.push(
      audit(ctx, caller, "config.apply", "settings", "site", {
        changes: applied,
      }),
    );
    await ctx.store.atomic(queries);
  }
  return { changes };
}
