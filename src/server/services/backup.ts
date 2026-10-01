import type { Compilable } from "kysely";
import { sql } from "kysely";
import { badRequest, type Ctx, conflict, HttpError } from "../context.ts";
import { appliedMigrations } from "../db/migrations.ts";
import type { Database } from "../db/schema.ts";

// A backup is the whole database as text: one JSON object per line, gzipped.
// It is deliberately not a copy of any engine's own files. The same backup
// restores onto SQLite, Postgres or D1, so it is also how an installation
// moves from one kind of deployment to another.
//
//   line 1   {"clearanceBackup":1,"exportedAt":...,"migrations":[...]}
//   then     {"t":"<table>","r":{...row...}}          one per row
//   last     {"end":true,"counts":{"<table>":n,...}}  proves the file is whole
//
// Everything is streamed, a page of rows at a time, because signed records
// carry their PDFs and a Worker has little memory.

type Table = keyof Database;

/**
 * What is backed up, parents before children so that a restore never inserts
 * a row before the row it refers to. Sessions and half-finished passkey
 * prompts are left out: they are not records, and restoring a sign-in would
 * be a surprise.
 */
const TABLES: { name: Table; order: string[]; page: number }[] = [
  { name: "settings", order: ["key"], page: 500 },
  { name: "users", order: ["id"], page: 500 },
  { name: "credentials", order: ["id"], page: 500 },
  { name: "groups", order: ["id"], page: 500 },
  { name: "group_members", order: ["group_id", "user_id"], page: 500 },
  { name: "invites", order: ["id"], page: 500 },
  { name: "guardianships", order: ["id"], page: 500 },
  { name: "clearances", order: ["id"], page: 500 },
  { name: "document_versions", order: ["id"], page: 50 },
  // Each of these rows carries a PDF.
  { name: "signatures", order: ["id"], page: 25 },
  { name: "grants", order: ["id"], page: 500 },
  { name: "audit_log", order: ["id"], page: 500 },
];

const FORMAT = 1;
/** Rows per atomic write on restore; D1 caps a batch at 100 statements. */
const RESTORE_BATCH = 25;

async function* lines(ctx: Ctx): AsyncGenerator<string> {
  yield JSON.stringify({
    clearanceBackup: FORMAT,
    exportedAt: ctx.now(),
    migrations: await appliedMigrations(ctx.db),
  });
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    let count = 0;
    for (let offset = 0; ; offset += table.page) {
      let query = ctx.db
        .selectFrom(table.name as never)
        .selectAll()
        .limit(table.page)
        .offset(offset);
      for (const column of table.order) query = query.orderBy(column as never);
      const rows = (await query.execute()) as Record<string, unknown>[];
      for (const row of rows) yield JSON.stringify({ t: table.name, r: row });
      count += rows.length;
      if (rows.length < table.page) break;
    }
    counts[table.name] = count;
  }
  yield JSON.stringify({ end: true, counts });
}

/** The backup as a gzipped stream, ready to be a response body or a file. */
export function exportBackup(ctx: Ctx): ReadableStream<Uint8Array> {
  const source = lines(ctx);
  const encoder = new TextEncoder();
  const text = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await source.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(`${next.value}\n`));
    },
    async cancel() {
      await source.return(undefined);
    },
  });
  return text.pipeThrough(
    new CompressionStream("gzip") as unknown as TransformStream<
      Uint8Array,
      Uint8Array
    >,
  );
}

export function backupFilename(now: string): string {
  return `clearance-${now.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.ndjson.gz`;
}

async function* readLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  // Accept a backup whether or not something along the way unzipped it.
  const first = await reader.read();
  const head = first.value ?? new Uint8Array();
  const zipped = head[0] === 0x1f && head[1] === 0x8b;
  const rejoined = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.length) controller.enqueue(head);
      if (first.done) controller.close();
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
  });
  const bytes = zipped
    ? rejoined.pipeThrough(
        new DecompressionStream("gzip") as unknown as TransformStream<
          Uint8Array,
          Uint8Array
        >,
      )
    : rejoined;

  const decoder = new TextDecoder();
  let buffer = "";
  const text = bytes.getReader();
  for (;;) {
    const chunk = await text.read();
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), {
      stream: !chunk.done,
    });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) yield line;
    }
    if (chunk.done) break;
  }
  if (buffer.trim()) yield buffer;
}

/** True when the database holds no people: a fresh install, or one wiped by a failed restore. */
export async function isEmpty(ctx: Ctx): Promise<boolean> {
  const user = await ctx.db
    .selectFrom("users")
    .select("id")
    .limit(1)
    .executeTakeFirst();
  return !user;
}

async function wipe(ctx: Ctx) {
  for (const table of [...TABLES].reverse()) {
    await sql`delete from ${sql.table(table.name)}`.execute(ctx.db);
  }
}

/**
 * Loads a backup into an empty database. There is no transaction that spans a
 * whole restore on every engine, so a restore that fails part-way empties the
 * database again instead of leaving half of one behind.
 */
export async function restoreBackup(
  ctx: Ctx,
  stream: ReadableStream<Uint8Array>,
): Promise<Record<string, number>> {
  if (!(await isEmpty(ctx))) {
    throw conflict("A backup can only be restored into an empty installation.");
  }
  const known = new Set<string>(TABLES.map((table) => table.name));
  const applied = new Set(await appliedMigrations(ctx.db));
  const counts: Record<string, number> = {};
  let sawHeader = false;
  let expected: Record<string, number> | null = null;
  let pending: Compilable[] = [];
  const flush = async () => {
    if (pending.length) await ctx.store.atomic(pending);
    pending = [];
  };

  try {
    // Setup may have left settings behind (it can be half-done); the backup's own replace them.
    await wipe(ctx);
    for await (const line of readLines(stream)) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw badRequest("This is not a Clearance backup file.");
      }
      if (!sawHeader) {
        if (
          entry.clearanceBackup !== FORMAT ||
          !Array.isArray(entry.migrations)
        ) {
          throw badRequest("This is not a Clearance backup file.");
        }
        const newer = (entry.migrations as string[]).filter(
          (name) => !applied.has(name),
        );
        if (newer.length) {
          throw badRequest(
            "This backup was made by a newer version of Clearance. Update first, then restore.",
          );
        }
        sawHeader = true;
        continue;
      }
      if (entry.end === true) {
        expected = entry.counts as Record<string, number>;
        continue;
      }
      const table = entry.t;
      if (typeof table !== "string" || !known.has(table) || !entry.r) {
        throw badRequest("The backup file contains something unexpected.");
      }
      pending.push(ctx.db.insertInto(table as never).values(entry.r as never));
      counts[table] = (counts[table] ?? 0) + 1;
      if (pending.length >= RESTORE_BATCH) await flush();
    }
    await flush();

    if (!sawHeader) throw badRequest("This is not a Clearance backup file.");
    if (!expected)
      throw badRequest("The backup file is cut short; it has no end marker.");
    for (const [table, count] of Object.entries(expected)) {
      if ((counts[table] ?? 0) !== count) {
        throw badRequest(
          `The backup file is incomplete: ${table} should have ${count} rows.`,
        );
      }
    }
  } catch (error) {
    await wipe(ctx);
    if (error instanceof HttpError) throw error;
    // A damaged archive, or a row the database would not take.
    throw badRequest(
      `The backup could not be restored: ${(error as Error).message}`,
    );
  }
  return counts;
}
