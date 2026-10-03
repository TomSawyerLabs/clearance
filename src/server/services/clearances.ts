import { z } from "zod";
import {
  type Capacity,
  checkMarkers,
  type Field,
  fieldsSchema,
} from "../../shared/document.ts";
import type { Settings } from "../../shared/settings.ts";
import {
  badRequest,
  type Caller,
  conflict,
  type Ctx,
  notFound,
  requireAdmin,
  requireUser,
} from "../context.ts";
import type {
  ClearancesTable,
  DocumentVersionsTable,
  UsersTable,
} from "../db/schema.ts";
import {
  documentFingerprint,
  normalizeDocument,
  resolveDocument,
} from "../../shared/documentFile.ts";
import { newId } from "../lib/util.ts";
import { audit } from "./audit.ts";
import { isWard, requireOversight } from "./people.ts";
import { getSettings } from "./settings.ts";

// ---------------------------------------------------------------------------
// Definitions

export const clearanceInput = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).default(""),
  /**
   * A release is signed by the person, or their guardian. A certification is
   * signed by a mentor, attesting that the person is trained. Chosen when the
   * document is created and fixed after that: records have been signed in
   * one capacity or the other.
   */
  kind: z.enum(["release", "certification"]).default("release"),
  requiredForAll: z.boolean().default(false),
  /** Null: valid until revoked or superseded. */
  validityDays: z.number().int().min(1).max(3650).nullable().default(null),
  minorPolicy: z.enum(["guardian", "guardian_and_minor"]).default("guardian"),
});

/**
 * Written out rather than derived with `.partial()`: a partial of a schema
 * with defaults fills the defaults in for every absent key, so a patch of one
 * field would silently reset the others. The kind is not here; it is fixed.
 */
export const clearancePatch = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(1000).optional(),
  requiredForAll: z.boolean().optional(),
  validityDays: z.number().int().min(1).max(3650).nullable().optional(),
  minorPolicy: z.enum(["guardian", "guardian_and_minor"]).optional(),
  archived: z.boolean().optional(),
});

export interface ClearanceDto {
  id: string;
  name: string;
  description: string;
  kind: ClearancesTable["kind"];
  requiredForAll: boolean;
  validityDays: number | null;
  minorPolicy: ClearancesTable["minor_policy"];
  archived: boolean;
  /** The version people sign today, if one has been published. */
  current: {
    id: string;
    version: number;
    title: string;
    publishedAt: string;
  } | null;
}

type VersionMeta = Pick<
  DocumentVersionsTable,
  "id" | "clearance_id" | "version" | "title" | "published_at" | "supersedes"
>;

async function versionMeta(ctx: Ctx): Promise<VersionMeta[]> {
  return ctx.db
    .selectFrom("document_versions")
    .select([
      "id",
      "clearance_id",
      "version",
      "title",
      "published_at",
      "supersedes",
    ])
    .orderBy("version")
    .execute();
}

function currentOf(
  versions: VersionMeta[],
  clearanceId: string,
): VersionMeta | undefined {
  return versions
    .filter((version) => version.clearance_id === clearanceId)
    .at(-1);
}

function toDto(row: ClearancesTable, versions: VersionMeta[]): ClearanceDto {
  const current = currentOf(versions, row.id);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    requiredForAll: row.required_for_all === 1,
    validityDays: row.validity_days,
    minorPolicy: row.minor_policy,
    archived: row.archived_at !== null,
    current: current
      ? {
          id: current.id,
          version: current.version,
          title: current.title,
          publishedAt: current.published_at,
        }
      : null,
  };
}

export async function listClearances(
  ctx: Ctx,
  caller: Caller,
): Promise<ClearanceDto[]> {
  const user = requireUser(caller);
  let query = ctx.db.selectFrom("clearances").selectAll().orderBy("name");
  // Everyone sees what can be signed; only an admin sees retired ones and drafts.
  if (!user.is_admin) query = query.where("archived_at", "is", null);
  const [rows, versions] = await Promise.all([
    query.execute(),
    versionMeta(ctx),
  ]);
  return rows
    .map((row) => toDto(row, versions))
    .filter((clearance) => user.is_admin || clearance.current);
}

export async function createClearance(ctx: Ctx, caller: Caller, raw: unknown) {
  requireAdmin(caller);
  const parsed = clearanceInput.safeParse(raw);
  if (!parsed.success)
    throw badRequest("Check the details and try again.", parsed.error.issues);
  const row: ClearancesTable = {
    id: newId(),
    name: parsed.data.name,
    description: parsed.data.description,
    kind: parsed.data.kind,
    required_for_all: parsed.data.requiredForAll ? 1 : 0,
    validity_days: parsed.data.validityDays,
    minor_policy: parsed.data.minorPolicy,
    created_at: ctx.now(),
    archived_at: null,
  };
  await ctx.store.atomic([
    ctx.db.insertInto("clearances").values(row),
    audit(ctx, caller, "clearance.create", "clearance", row.id, {
      name: row.name,
    }),
  ]);
  return toDto(row, []);
}

export async function updateClearance(
  ctx: Ctx,
  caller: Caller,
  id: string,
  raw: unknown,
) {
  requireAdmin(caller);
  const parsed = clearancePatch.safeParse(raw);
  if (!parsed.success)
    throw badRequest("Check the details and try again.", parsed.error.issues);
  const patch = parsed.data;
  const result = await ctx.db
    .updateTable("clearances")
    .set({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && {
        description: patch.description,
      }),
      ...(patch.requiredForAll !== undefined && {
        required_for_all: patch.requiredForAll ? 1 : 0,
      }),
      ...(patch.validityDays !== undefined && {
        validity_days: patch.validityDays,
      }),
      ...(patch.minorPolicy !== undefined && {
        minor_policy: patch.minorPolicy,
      }),
      ...(patch.archived !== undefined && {
        archived_at: patch.archived ? ctx.now() : null,
      }),
    })
    .where("id", "=", id)
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n)
    throw notFound("That clearance does not exist.");
  await audit(
    ctx,
    caller,
    "clearance.update",
    "clearance",
    id,
    patch,
  ).execute();
}

// ---------------------------------------------------------------------------
// Document versions. A version is immutable: fixing a typo means publishing a
// new one, because people have signed the old text.

export const versionInput = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().min(1).max(100_000),
  fields: fieldsSchema.default([]),
  /** False for a correction that does not require everyone to sign again. */
  supersedes: z.boolean().default(true),
});

export interface VersionDto {
  id: string;
  clearanceId: string;
  version: number;
  title: string;
  body: string;
  fields: Field[];
  bodyHash: string;
  supersedes: boolean;
  publishedAt: string;
}

function versionDto(row: DocumentVersionsTable): VersionDto {
  return {
    id: row.id,
    clearanceId: row.clearance_id,
    version: row.version,
    title: row.title,
    body: row.body,
    fields: JSON.parse(row.fields) as Field[],
    bodyHash: row.body_hash,
    supersedes: row.supersedes === 1,
    publishedAt: row.published_at,
  };
}

export async function publishVersion(
  ctx: Ctx,
  caller: Caller,
  clearanceId: string,
  raw: unknown,
) {
  const admin = requireAdmin(caller);
  const parsed = versionInput.safeParse(raw);
  if (!parsed.success)
    throw badRequest("Check the document and try again.", parsed.error.issues);
  const clearance = await ctx.db
    .selectFrom("clearances")
    .select("id")
    .where("id", "=", clearanceId)
    .executeTakeFirst();
  if (!clearance) throw notFound("That clearance does not exist.");

  const latest = await ctx.db
    .selectFrom("document_versions")
    .select((eb) => eb.fn.max("version").as("version"))
    .where("clearance_id", "=", clearanceId)
    .executeTakeFirst();
  // The variables are filled in now, so that what is stored, fingerprinted
  // and signed is the words, not a template that could read differently later.
  const { variables } = await getSettings(ctx);
  const resolved = resolveDocument(parsed.data, variables);
  if (resolved.missing.length) {
    throw badRequest(
      `The text uses variables that are not set: ${resolved.missing.join(", ")}. Set them in Settings.`,
      { missing: resolved.missing },
    );
  }
  const markerProblems = checkMarkers(
    resolved.content.body,
    resolved.content.fields,
  );
  if (markerProblems.length)
    throw badRequest(markerProblems.join(" "), { markers: markerProblems });
  // Stored exactly as fingerprinted: normalised line endings, no stray keys.
  const content = normalizeDocument(resolved.content);
  const row: DocumentVersionsTable = {
    id: newId(),
    clearance_id: clearanceId,
    version: Number(latest?.version ?? 0) + 1,
    title: content.title,
    body: content.body,
    fields: JSON.stringify(content.fields),
    // Covers everything the signer is shown and asked, and can be reproduced
    // from the document's files with `clearance hash`.
    body_hash: await documentFingerprint(content),
    supersedes: parsed.data.supersedes ? 1 : 0,
    published_at: ctx.now(),
    published_by: admin.id,
  };
  try {
    await ctx.store.atomic([
      ctx.db.insertInto("document_versions").values(row),
      audit(ctx, caller, "document.publish", "clearance", clearanceId, {
        version: row.version,
      }),
    ]);
  } catch {
    // The unique (clearance, version) constraint caught a concurrent publish.
    throw conflict(
      "Someone else published a version just now. Reload and try again.",
    );
  }
  return versionDto(row);
}

export async function listVersions(
  ctx: Ctx,
  caller: Caller,
  clearanceId: string,
) {
  requireAdmin(caller);
  const rows = await ctx.db
    .selectFrom("document_versions")
    .selectAll()
    .where("clearance_id", "=", clearanceId)
    .orderBy("version", "desc")
    .execute();
  return rows.map(versionDto);
}

export async function currentVersion(
  ctx: Ctx,
  clearanceId: string,
): Promise<VersionDto | null> {
  const row = await ctx.db
    .selectFrom("document_versions")
    .selectAll()
    .where("clearance_id", "=", clearanceId)
    .orderBy("version", "desc")
    .limit(1)
    .executeTakeFirst();
  return row ? versionDto(row) : null;
}

export async function getVersion(ctx: Ctx, id: string): Promise<VersionDto> {
  const row = await ctx.db
    .selectFrom("document_versions")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw notFound("That document version does not exist.");
  return versionDto(row);
}

// ---------------------------------------------------------------------------
// Status: does this person hold this clearance right now?

export type ClearanceState =
  /** Held and valid. */
  | "active"
  /** Never signed. */
  | "missing"
  /** Some but not all of the required people have signed. */
  | "pending"
  /** Was held; the validity period ran out. */
  | "expired"
  /** Was held; the document changed or the person came of age. */
  | "stale";

export interface ClearanceStatus {
  clearanceId: string;
  name: string;
  kind: ClearancesTable["kind"];
  required: boolean;
  state: ClearanceState;
  /** Plain-language reason, for `stale`. */
  reason: string | null;
  /** Who still has to sign for this to become active. */
  waitingOn: Capacity[];
  signed: Capacity[];
  grantId: string | null;
  grantedAt: string | null;
  expiresAt: string | null;
  /** Signed records behind the current state, newest first. */
  signatureIds: string[];
}

export function requiredCapacities(
  user: Pick<UsersTable, "birthdate">,
  clearance: Pick<ClearancesTable, "kind" | "minor_policy">,
  settings: Settings,
  now: string,
): Capacity[] {
  // A certification is a mentor's word, whoever the person is.
  if (clearance.kind === "certification") return ["attester"];
  if (!isWard(user, settings, now)) return ["self"];
  return clearance.minor_policy === "guardian_and_minor"
    ? ["guardian", "minor"]
    : ["guardian"];
}

/**
 * The status of every signable clearance for each of `users`. Done in memory
 * from four queries so that a group page costs the same on every engine.
 */
export async function statusesFor(
  ctx: Ctx,
  settings: Settings,
  users: UsersTable[],
): Promise<Map<string, ClearanceStatus[]>> {
  const out = new Map<string, ClearanceStatus[]>();
  if (users.length === 0) return out;
  const now = ctx.now();
  const ids = users.map((user) => user.id);

  const [clearances, versions, grants, signatures, memberships] =
    await Promise.all([
      ctx.db
        .selectFrom("clearances")
        .selectAll()
        .where("archived_at", "is", null)
        .orderBy("name")
        .execute(),
      versionMeta(ctx),
      ctx.db
        .selectFrom("grants")
        .selectAll()
        .where("user_id", "in", ids)
        .where("revoked_at", "is", null)
        .orderBy("granted_at", "desc")
        .execute(),
      ctx.db
        .selectFrom("signatures")
        .select([
          "id",
          "subject_id",
          "document_version_id",
          "capacity",
          "signed_at",
        ])
        .where("subject_id", "in", ids)
        .orderBy("signed_at", "desc")
        .execute(),
      ctx.db
        .selectFrom("group_members")
        .select("user_id")
        .where("user_id", "in", ids)
        .execute(),
    ]);
  // "Required" is about participants. A parent who has an account only to
  // sign for a child is in no group, and is not chased for a release.
  const participants = new Set(memberships.map((row) => row.user_id));

  for (const user of users) {
    const statuses: ClearanceStatus[] = [];
    for (const clearance of clearances) {
      const current = currentOf(versions, clearance.id);
      if (!current) continue;

      const grant = grants.find(
        (g) => g.user_id === user.id && g.clearance_id === clearance.id,
      );
      let lapsed: { state: "expired" | "stale"; reason: string | null } | null =
        null;
      if (grant) {
        const signedVersion = versions.find(
          (v) => v.id === grant.document_version_id,
        );
        const superseded = versions.some(
          (v) =>
            v.clearance_id === clearance.id &&
            v.supersedes === 1 &&
            v.version > (signedVersion?.version ?? 0),
        );
        if (grant.expires_at && grant.expires_at <= now) {
          lapsed = { state: "expired", reason: null };
        } else if (grant.signed_as_minor && !isWard(user, settings, now)) {
          lapsed = {
            state: "stale",
            reason:
              "Signed by a guardian; now an adult, so must sign personally.",
          };
        } else if (superseded) {
          lapsed = {
            state: "stale",
            reason: "The document has changed since it was signed.",
          };
        }
      }

      // While a grant is valid, show the signatures that produced it. Once it
      // has lapsed (or there never was one), only signatures made on the
      // current text since then count toward the next grant.
      const active = Boolean(grant && !lapsed);
      const round = signatures.filter((s) => {
        if (s.subject_id !== user.id) return false;
        if (grant && active) {
          return (
            s.document_version_id === grant.document_version_id &&
            s.signed_at <= grant.granted_at
          );
        }
        return (
          s.document_version_id === current.id &&
          s.signed_at > (grant?.granted_at ?? "")
        );
      });
      const required = requiredCapacities(user, clearance, settings, now);
      const signed = required.filter((capacity) =>
        round.some((s) => s.capacity === capacity),
      );

      statuses.push({
        clearanceId: clearance.id,
        name: clearance.name,
        kind: clearance.kind,
        required: clearance.required_for_all === 1 && participants.has(user.id),
        state: active
          ? "active"
          : signed.length
            ? "pending"
            : (lapsed?.state ?? "missing"),
        reason: active || signed.length ? null : (lapsed?.reason ?? null),
        waitingOn: active
          ? []
          : required.filter((capacity) => !signed.includes(capacity)),
        signed: active ? required : signed,
        grantId: grant?.id ?? null,
        grantedAt: grant?.granted_at ?? null,
        expiresAt: grant?.expires_at ?? null,
        signatureIds: round.map((s) => s.id),
      });
    }
    out.set(user.id, statuses);
  }
  return out;
}

export async function revokeGrant(
  ctx: Ctx,
  caller: Caller,
  grantId: string,
  reason: string,
) {
  const grant = await ctx.db
    .selectFrom("grants")
    .selectAll()
    .where("id", "=", grantId)
    .executeTakeFirst();
  if (!grant) throw notFound("That clearance record does not exist.");
  const actor = await requireOversight(ctx, caller, grant.user_id);
  await ctx.store.atomic([
    ctx.db
      .updateTable("grants")
      .set({
        revoked_at: ctx.now(),
        revoked_by: actor.id,
        revoke_reason: reason.slice(0, 500),
      })
      .where("id", "=", grantId)
      .where("revoked_at", "is", null),
    audit(ctx, caller, "grant.revoke", "user", grant.user_id, {
      grant: grantId,
      clearance: grant.clearance_id,
      reason,
    }),
  ]);
}
