import type { Database as BunDatabase } from "bun:sqlite";
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

// Kysely ships a SQLite dialect for better-sqlite3, a native Node module. This
// is the same thing over Bun's built-in SQLite, so a compiled Clearance binary
// carries its database engine with it.

class BunSqliteConnection implements DatabaseConnection {
  constructor(private readonly db: BunDatabase) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const statement = this.db.prepare(query.sql);
    const parameters = query.parameters as never[];
    if (statement.columnNames.length > 0) {
      return { rows: statement.all(...parameters) as R[] };
    }
    const result = statement.run(...parameters);
    return { rows: [], numAffectedRows: BigInt(result.changes) };
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("Streaming is not supported by the bun:sqlite driver.");
  }
}

class BunSqliteDriver implements Driver {
  private readonly connection: BunSqliteConnection;
  // SQLite has one writer. Queue callers so that a transaction's statements
  // are never interleaved with another caller's.
  private tail: Promise<void> = Promise.resolve();
  private release: (() => void) | undefined;

  constructor(private readonly db: BunDatabase) {
    this.connection = new BunSqliteConnection(db);
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    this.release = release;
    return this.connection;
  }

  async beginTransaction(): Promise<void> {
    this.db.run("begin immediate");
  }

  async commitTransaction(): Promise<void> {
    this.db.run("commit");
  }

  async rollbackTransaction(): Promise<void> {
    this.db.run("rollback");
  }

  async releaseConnection(): Promise<void> {
    const release = this.release;
    this.release = undefined;
    release?.();
  }

  async destroy(): Promise<void> {
    this.db.close();
  }
}

export function bunSqliteDialect(db: BunDatabase): Dialect {
  return {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new BunSqliteDriver(db),
    createIntrospector: (kysely) => new SqliteIntrospector(kysely),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  };
}
