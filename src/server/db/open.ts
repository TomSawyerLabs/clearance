import { Database as BunDatabase } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { bunSqliteDialect } from "./dialects/bun-sqlite.ts";
import type { Database } from "./schema.ts";
import { type Store, transactionalStore } from "./store.ts";

// Bun-only: opens the embedded SQLite file or connects to Postgres. The
// Workers entry point builds its Store from a D1 binding instead and never
// imports this file.

export const DEFAULT_DATABASE_URL = "sqlite:./data/clearance.db";

/**
 * `sqlite:<path>` (or `sqlite::memory:`) for the embedded database,
 * `postgres://...` for a managed one.
 */
export function openStore(
  url: string = DEFAULT_DATABASE_URL,
  options: { poolMax?: number } = {},
): Store {
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const pool = new pg.Pool({ connectionString: url, max: options.poolMax });
    return transactionalStore(
      "postgres",
      new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }),
    );
  }

  if (url.startsWith("sqlite:")) {
    const location = url.slice("sqlite:".length);
    let sqlite: BunDatabase;
    if (location === ":memory:") {
      sqlite = new BunDatabase(":memory:");
    } else {
      const file = resolve(location);
      mkdirSync(dirname(file), { recursive: true });
      sqlite = new BunDatabase(file, { create: true });
      sqlite.run("pragma journal_mode = wal");
    }
    sqlite.run("pragma foreign_keys = on");
    sqlite.run("pragma busy_timeout = 5000");
    return transactionalStore(
      "sqlite",
      new Kysely<Database>({ dialect: bunSqliteDialect(sqlite) }),
    );
  }

  throw new Error(
    `Unsupported DATABASE_URL "${url.split(":")[0]}:". Use sqlite:<path> or postgres://...`,
  );
}
