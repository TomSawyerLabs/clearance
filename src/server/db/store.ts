import {
  type Compilable,
  type CompiledQuery,
  Kysely,
  type QueryResult,
} from "kysely";
import { type D1Database, d1Batch, d1Dialect } from "./dialects/d1.ts";
import type { Database } from "./schema.ts";

export type Engine = "sqlite" | "postgres" | "d1";

/**
 * The database handle the application is written against.
 *
 * `db` is for single statements. Anything that must be all-or-nothing goes
 * through `atomic`, because D1 has no interactive transactions: every engine is
 * given the full list of statements up front.
 */
export interface Store {
  readonly engine: Engine;
  readonly db: Kysely<Database>;
  atomic(queries: readonly Compilable[]): Promise<QueryResult<unknown>[]>;
  close(): Promise<void>;
}

/** For engines with real transactions (SQLite, Postgres). */
export function transactionalStore(
  engine: Engine,
  db: Kysely<Database>,
): Store {
  return {
    engine,
    db,
    async atomic(queries) {
      const compiled = queries.map((query) => query.compile());
      return db.transaction().execute(async (trx) => {
        const results: QueryResult<unknown>[] = [];
        for (const query of compiled)
          results.push(await trx.executeQuery(query));
        return results;
      });
    },
    close: () => db.destroy(),
  };
}

export function d1Store(d1: D1Database): Store {
  const db = new Kysely<Database>({ dialect: d1Dialect(d1) });
  return {
    engine: "d1",
    db,
    atomic: (queries) =>
      d1Batch(
        d1,
        queries.map((query): CompiledQuery => query.compile()),
      ),
    close: () => db.destroy(),
  };
}
