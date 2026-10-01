import { createApi } from "../server/app.ts";
import { createCtx } from "../server/context.ts";
import type { D1Database } from "../server/db/dialects/d1.ts";
import { migrateToLatest } from "../server/db/migrations.ts";
import { d1Store } from "../server/db/store.ts";

// Cloudflare Workers. The database is a D1 binding named DB, and the web UI is
// served by Workers Static Assets (see wrangler.jsonc), so this Worker only
// ever sees /api requests.

interface Env {
  DB: D1Database;
}

let ready: Promise<ReturnType<typeof createApi>> | undefined;

/**
 * Built once per isolate. Migrations run here, on the first request after a
 * deploy, so that publishing a new version needs no separate migration step.
 */
function api(env: Env) {
  ready ??= (async () => {
    const store = d1Store(env.DB);
    await migrateToLatest(store.db);
    return createApi({
      ctx: createCtx(store),
      // Set by Cloudflare's edge itself; a visitor cannot forge it.
      clientIp: (request) => request.headers.get("cf-connecting-ip") ?? "",
    });
  })();
  // A failed start-up must not poison the isolate for every later request.
  ready.catch(() => (ready = undefined));
  return ready;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await api(env)).fetch(request);
  },
};
