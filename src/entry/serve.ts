import { existsSync, unlinkSync } from "node:fs";
import { createApi } from "../server/app.ts";
import { createCtx } from "../server/context.ts";
import { migrateToLatest } from "../server/db/migrations.ts";
import { DEFAULT_DATABASE_URL, openStore } from "../server/db/open.ts";
import { getSettings, settingQueries } from "../server/services/settings.ts";
import {
  DEFAULT_SETTINGS,
  type Settings,
  settingsSchema,
} from "../shared/settings.ts";

// The Bun server, for bare metal and containers. Only what is needed to find
// the database and open a listener comes from the environment; every other
// setting lives in the database and is edited in the admin UI.
//
//   DATABASE_URL  sqlite:<path> (default sqlite:./data/clearance.db) or postgres://...
//   PORT, HOST    TCP listener (default 127.0.0.1:8080)
//   SOCKET_PATH   listen on a unix socket instead, for a reverse proxy on the same host

/** Looks up a static file by URL path, e.g. `/assets/app.js`. */
export type AssetSource = (path: string) => Blob | null;

const USAGE = `Usage:
  clearance [serve]              run the server
  clearance config               print the current settings
  clearance config set KEY JSON  change a setting without the web UI, e.g.
                                 clearance config set origin '"https://release.example.org"'
  clearance migrate              apply database migrations and exit
`;

export async function main(
  assets: AssetSource,
  argv: string[] = process.argv.slice(2),
) {
  const [command = "serve", ...rest] = argv;
  if (!["serve", "config", "migrate"].includes(command)) {
    console.error(USAGE);
    process.exit(command === "help" || command === "--help" ? 0 : 2);
  }

  const store = openStore(process.env.DATABASE_URL || DEFAULT_DATABASE_URL);
  const applied = await migrateToLatest(store.db);
  if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);
  const ctx = createCtx(store);

  if (command === "migrate") {
    await store.close();
    return;
  }

  if (command === "config") {
    await config(ctx, rest);
    await store.close();
    return;
  }

  const api = createApi({
    ctx,
    clientIp: (request) => server.requestIP(request)?.address ?? "",
  });

  const fetch = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api" || pathname.startsWith("/api/"))
      return api.fetch(request);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    const file = assets(pathname);
    if (file) {
      return new Response(file, {
        headers: {
          // Vite fingerprints everything under /assets, so it never changes.
          "cache-control": pathname.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        },
      });
    }
    // Any other path is a page of the single-page app.
    const index = assets("/index.html");
    if (!index) {
      return new Response(
        "The web UI has not been built. Run `bun run build`.",
        { status: 503 },
      );
    }
    return new Response(index, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  };

  const socketPath = process.env.SOCKET_PATH;
  if (socketPath && existsSync(socketPath)) unlinkSync(socketPath);
  const server = socketPath
    ? Bun.serve({ unix: socketPath, fetch })
    : Bun.serve({
        hostname: process.env.HOST || "127.0.0.1",
        port: Number(process.env.PORT || 8080),
        fetch,
      });

  console.log(
    `Clearance is listening on ${socketPath ?? server.url} (${store.engine})`,
  );

  const stop = async () => {
    await server.stop();
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function config(ctx: ReturnType<typeof createCtx>, args: string[]) {
  if (args.length === 0) {
    console.log(JSON.stringify(await getSettings(ctx), null, 2));
    return;
  }
  const [verb, key, json] = args;
  if (
    verb !== "set" ||
    !key ||
    json === undefined ||
    !(key in DEFAULT_SETTINGS)
  ) {
    console.error(
      `${USAGE}\nSettings: ${Object.keys(DEFAULT_SETTINGS).join(", ")}`,
    );
    process.exit(2);
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    // Let a bare word stand for a string, so quoting JSON in a shell is optional.
    value = json;
  }
  const parsed = settingsSchema.partial().safeParse({ [key]: value });
  if (!parsed.success) {
    console.error(parsed.error.issues.map((issue) => issue.message).join("\n"));
    process.exit(2);
  }
  await ctx.store.atomic(
    settingQueries(ctx, parsed.data as Partial<Settings>, null),
  );
  console.log(`${key} = ${JSON.stringify(value)}`);
}
