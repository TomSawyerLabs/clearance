import {
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";

// The parts of Cloudflare's D1 binding this app uses. Declared here instead of
// pulling in @cloudflare/workers-types, whose globals collide with the DOM and
// Bun typings the rest of the project is checked against.
export interface D1Result {
  results?: unknown[];
  meta: { changes: number };
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all(): Promise<D1Result>;
}
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

function toResult<R>(result: D1Result): QueryResult<R> {
  return {
    rows: (result.results ?? []) as R[],
    numAffectedRows: BigInt(result.meta.changes ?? 0),
  };
}

function prepare(d1: D1Database, query: CompiledQuery): D1PreparedStatement {
  return d1.prepare(query.sql).bind(...query.parameters);
}

class D1Connection implements DatabaseConnection {
  constructor(private readonly d1: D1Database) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    return toResult<R>(await prepare(this.d1, query).all());
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("Streaming is not supported by D1.");
  }
}

const NO_TRANSACTIONS =
  "D1 has no interactive transactions. Use Store.atomic(), which runs a batch on D1.";

class D1Driver implements Driver {
  constructor(private readonly d1: D1Database) {}
  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return new D1Connection(this.d1);
  }
  async beginTransaction(): Promise<void> {
    throw new Error(NO_TRANSACTIONS);
  }
  async commitTransaction(): Promise<void> {
    throw new Error(NO_TRANSACTIONS);
  }
  async rollbackTransaction(): Promise<void> {
    throw new Error(NO_TRANSACTIONS);
  }
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

export function d1Dialect(d1: D1Database): Dialect {
  return {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new D1Driver(d1),
    createIntrospector: (kysely) => new SqliteIntrospector(kysely),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  };
}

/** All statements succeed or none do; this is D1's only form of atomicity. */
export async function d1Batch(
  d1: D1Database,
  queries: readonly CompiledQuery[],
): Promise<QueryResult<unknown>[]> {
  if (queries.length === 0) return [];
  const results = await d1.batch(queries.map((query) => prepare(d1, query)));
  return results.map((result) => toResult(result));
}
