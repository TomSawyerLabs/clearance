import { sql } from "kysely";
import { createApi } from "../../src/server/app.ts";
import { createCtx, type Ctx } from "../../src/server/context.ts";
import { migrateToLatest } from "../../src/server/db/migrations.ts";
import { openStore } from "../../src/server/db/open.ts";
import type { Store } from "../../src/server/db/store.ts";
import { VirtualAuthenticator } from "./authenticator.ts";

// D1 is not in this list: it only exists inside the Workers runtime, so it is
// covered by test/worker.test.ts, which drives a real `wrangler dev`.
export type EngineName = "sqlite" | "postgres";

/** `TEST_ENGINES=sqlite bun test` runs one engine; the default is both. */
export const ENGINES = (process.env.TEST_ENGINES ?? "sqlite,postgres")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean) as EngineName[];

export const ORIGIN = "https://clearance.test";

// PGlite is real Postgres compiled to WebAssembly. Putting it behind a socket
// means the app talks to it through `pg`, exactly as it would to a managed
// database. It takes many seconds to start and does not take kindly to
// reconnects, so one instance and one connection serve the whole run, and each
// test starts by emptying every table.
let postgres: Promise<Store> | undefined;
function sharedPostgres(): Promise<Store> {
  postgres ??= (async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
    const db = await PGlite.create();
    const port = 20000 + Math.floor(Math.random() * 20000);
    await new PGLiteSocketServer({ db, port, host: "127.0.0.1" }).start();
    const store = openStore(`postgres://postgres@127.0.0.1:${port}/postgres`, {
      poolMax: 1,
    });
    await migrateToLatest(store.db);
    return store;
  })();
  return postgres;
}

/** Starts whatever the engine needs before the first test. Call from `beforeAll` with a long timeout. */
export async function prepareEngine(engine: EngineName): Promise<void> {
  if (engine === "postgres") await sharedPostgres();
}

async function openEngine(
  engine: EngineName,
): Promise<{ store: Store; close(): Promise<void> }> {
  if (engine === "sqlite") {
    const store = openStore("sqlite::memory:");
    await migrateToLatest(store.db);
    return { store, close: () => store.close() };
  }
  const store = await sharedPostgres();
  const tables = await sql<{ tablename: string }>`
    select tablename from pg_tables
    where schemaname = ${"public"} and tablename <> ${"clearance_migrations"}
  `.execute(store.db);
  const names = tables.rows.map((row) => `"${row.tablename}"`).join(", ");
  await sql.raw(`truncate table ${names} cascade`).execute(store.db);
  return { store, close: async () => {} };
}

export interface Reply<T = any> {
  status: number;
  body: T;
  response: Response;
}

export class TestClient {
  private cookie: string | null = null;
  userId: string | null = null;

  /** Assignable, so a test can carry a person's passkeys over to another installation. */
  authenticator: VirtualAuthenticator;

  constructor(
    private readonly send: (request: Request) => Response | Promise<Response>,
    private readonly ip: string,
    private readonly origin: string = ORIGIN,
  ) {
    this.authenticator = new VirtualAuthenticator(origin);
  }

  async request<T = any>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Reply<T>> {
    const headers: Record<string, string> = {
      origin: this.origin,
      "x-test-ip": this.ip,
    };
    if (this.cookie) headers.cookie = this.cookie;
    // Bytes go as they are (a backup file); anything else is JSON.
    const bytes = body instanceof Uint8Array;
    if (body !== undefined && !bytes)
      headers["content-type"] = "application/json";
    const response = await this.send(
      new Request(`${this.origin}/api${path}`, {
        method,
        headers,
        body:
          body === undefined
            ? undefined
            : bytes
              ? (body as Uint8Array<ArrayBuffer>)
              : JSON.stringify(body),
      }),
    );
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      const pair = setCookie.split(";")[0]!;
      this.cookie = pair.endsWith("=") ? null : pair;
    }
    const isJson = response.headers.get("content-type")?.includes("json");
    return {
      status: response.status,
      body: (isJson ? await response.clone().json() : null) as T,
      response,
    };
  }

  get = <T = any>(path: string) => this.request<T>("GET", path);
  post = <T = any>(path: string, body: unknown = {}) =>
    this.request<T>("POST", path, body);

  /** Like `post`, but a non-2xx reply fails the test with the server's message. */
  async ok<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const reply = await this.request<T>(method, path, body);
    if (reply.status >= 300) {
      throw new Error(
        `${method} ${path} -> ${reply.status}: ${JSON.stringify(reply.body)}`,
      );
    }
    return reply.body;
  }

  /** Creates a passkey and the account or credential the server decides it is for. */
  async register(
    input: Record<string, unknown>,
  ): Promise<Reply<{ userId: string }>> {
    const started = await this.post("/auth/register/options", input);
    if (started.status !== 200) return started;
    const response = await this.authenticator.create(started.body.options);
    const reply = await this.post("/auth/register/verify", {
      challengeId: started.body.challengeId,
      response,
      label: "Test passkey",
    });
    if (reply.status === 200) this.userId = reply.body.userId;
    return reply;
  }

  async login(): Promise<Reply<{ userId: string }>> {
    const started = await this.post("/auth/login/options");
    const response = await this.authenticator.get(started.body.options);
    const reply = await this.post("/auth/login/verify", {
      challengeId: started.body.challengeId,
      response,
    });
    if (reply.status === 200) this.userId = reply.body.userId;
    return reply;
  }

  async logout() {
    await this.post("/auth/logout");
  }

  async sign(
    clearanceId: string,
    subjectId: string,
    answers: Record<string, unknown> = {},
  ) {
    const started = await this.post("/sign/options", {
      clearanceId,
      subjectId,
      answers,
    });
    if (started.status !== 200) return started;
    const response = await this.authenticator.get(started.body.options);
    return this.post<{
      signatureId: string;
      granted: boolean;
      expiresAt: string | null;
    }>("/sign/verify", { challengeId: started.body.challengeId, response });
  }
}

export interface Harness {
  ctx: Ctx;
  api: ReturnType<typeof createApi>;
  /** Moves the application's clock forward. */
  advance(days: number): void;
  client(): TestClient;
  close(): Promise<void>;
}

export async function createHarness(
  engine: EngineName,
  /** As if the deployment had set PUBLIC_BASE_URL. */
  options: { origin?: string } = {},
): Promise<Harness> {
  const { store, close } = await openEngine(engine);

  let now = new Date("2026-10-01T18:00:00.000Z").getTime();
  // Each call moves the clock a little, as real requests would, so that
  // ordering by timestamp is meaningful in tests.
  const ctx = createCtx(
    store,
    () => new Date((now += 1000)).toISOString(),
    options.origin ?? null,
  );
  const api = createApi({
    ctx,
    clientIp: (request) => request.headers.get("x-test-ip") ?? "",
  });

  let clients = 0;
  return {
    ctx,
    api,
    advance(days) {
      now += days * 86_400_000;
    },
    client: () =>
      new TestClient((request) => api.fetch(request), `203.0.113.${++clients}`),
    close,
  };
}
