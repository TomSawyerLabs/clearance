import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createApi, type Snapshot } from "../server/app.ts";
import { createCtx } from "../server/context.ts";
import { migrateToLatest } from "../server/db/migrations.ts";
import { DEFAULT_DATABASE_URL, openStore } from "../server/db/open.ts";
import { addDays } from "../server/lib/util.ts";
import { audit } from "../server/services/audit.ts";
import {
  backupFilename,
  exportBackup,
  isEmpty,
  restoreBackup,
} from "../server/services/backup.ts";
import { createInvite } from "../server/services/invites.ts";
import { getSettings, settingQueries } from "../server/services/settings.ts";
import { fieldsSchema } from "../shared/document.ts";
import {
  documentFingerprint,
  fromMarkdownFile,
} from "../shared/documentFile.ts";
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
//   BACKUP_DIR    where automatic backups are written (default: a "backups"
//                 directory beside the SQLite file, or ./data/backups)
//   PUBLIC_BASE_URL
//                 the address people reach the site at, e.g.
//                 https://release.example.org. Passkeys are bound to its
//                 hostname and requests from anywhere else are refused. Unset:
//                 the address the first administrator registered from.
//   CLIENT_IP_HEADER
//                 the request header your reverse proxy puts the visitor's
//                 address in, e.g. X-Real-IP. Unset: the connection's own
//                 address. The address is printed on signed records, so only
//                 name a header the proxy overwrites; one passed through from
//                 the visitor can be forged.

/** Looks up a static file by URL path, e.g. `/assets/app.js`. */
export type AssetSource = (path: string) => Blob | null;

const USAGE = `Usage:
  clearance [serve]              run the server
  clearance config               print the current settings
  clearance config set KEY JSON  change a setting without the web UI, e.g.
                                 clearance config set siteName "Tom Sawyer Labs"
  clearance recovery-link [NAME] print a one-time link that gives an administrator
                                 (the first one, or the one named) a new passkey
  clearance backup [FILE]        write a backup now (default: into the backup directory)
  clearance restore FILE         load a backup into an empty installation
  clearance hash FILE.md [FIELDS.json]
                                 print the fingerprint a document would have if published,
                                 to match files in version control against a published version
  clearance migrate              apply database migrations and exit
`;

export async function main(
  assets: AssetSource,
  argv: string[] = process.argv.slice(2),
) {
  const [command = "serve", ...rest] = argv;
  const commands = [
    "serve",
    "config",
    "migrate",
    "recovery-link",
    "backup",
    "restore",
    "hash",
  ];
  if (!commands.includes(command)) {
    console.error(USAGE);
    process.exit(command === "help" || command === "--help" ? 0 : 2);
  }

  // Needs no database: it is run in a checkout of the documents, not on the server.
  if (command === "hash") {
    await hash(rest);
    return;
  }

  const databaseUrl = process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
  const backupDir = resolve(
    process.env.BACKUP_DIR ||
      (databaseUrl.startsWith("sqlite:") && databaseUrl !== "sqlite::memory:"
        ? join(dirname(databaseUrl.slice("sqlite:".length)), "backups")
        : "./data/backups"),
  );
  const clientIpHeader =
    process.env.CLIENT_IP_HEADER?.trim().toLowerCase() || null;
  if (clientIpHeader && !/^[a-z0-9-]+$/.test(clientIpHeader)) {
    console.error(
      `CLIENT_IP_HEADER must be a header name such as X-Real-IP, not "${process.env.CLIENT_IP_HEADER}".`,
    );
    process.exit(2);
  }
  const publicOrigin = process.env.PUBLIC_BASE_URL?.trim() || null;
  if (publicOrigin) {
    let valid = false;
    try {
      valid = new URL(publicOrigin).origin === publicOrigin;
    } catch {
      // not a URL at all
    }
    if (!valid) {
      console.error(
        `PUBLIC_BASE_URL must be exactly an origin such as https://release.example.org (no path, no trailing slash), not "${publicOrigin}".`,
      );
      process.exit(2);
    }
  }
  const store = openStore(databaseUrl);
  const applied = await migrateToLatest(store.db);
  if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);
  const ctx = createCtx(store, undefined, publicOrigin);

  if (command === "migrate") {
    await store.close();
    return;
  }

  if (command === "recovery-link") {
    await recoveryLink(ctx, rest.join(" ").trim());
    await store.close();
    return;
  }

  if (command === "config") {
    await config(ctx, rest);
    await store.close();
    return;
  }

  if (command === "backup") {
    const file = rest[0]
      ? resolve(rest[0])
      : join(backupDir, backupFilename(ctx.now()));
    await writeBackup(ctx, file);
    console.log(file);
    await store.close();
    return;
  }

  if (command === "restore") {
    if (!rest[0] || !existsSync(rest[0])) {
      console.error(USAGE);
      process.exit(2);
    }
    try {
      const counts = await restoreBackup(ctx, Bun.file(rest[0]).stream());
      const { origin } = await getSettings(ctx);
      console.log(`Restored: ${JSON.stringify(counts)}`);
      console.log(
        `This installation's address is ${origin}. Passkeys only work there.`,
      );
    } catch (error) {
      console.error((error as Error).message);
      process.exitCode = 1;
    }
    await store.close();
    return;
  }

  const api = createApi({
    ctx,
    clientIp: (request) => server.requestIP(request)?.address ?? "",
    clientIpHeader,
    snapshots: async () => listSnapshots(backupDir),
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

  // Automatic backups. Checked often and cheaply, so that a change to the
  // schedule in Settings takes effect without a restart.
  const snapshot = async () => {
    try {
      const settings = await getSettings(ctx);
      if (settings.backupEveryHours === 0 || (await isEmpty(ctx))) return;
      const newest = listSnapshots(backupDir)[0];
      const due =
        !newest ||
        Date.now() - new Date(newest.at).getTime() >=
          settings.backupEveryHours * 3_600_000;
      if (due)
        await writeBackup(ctx, join(backupDir, backupFilename(ctx.now())));
      for (const old of listSnapshots(backupDir).slice(settings.backupKeep)) {
        unlinkSync(join(backupDir, old.name));
      }
    } catch (error) {
      console.error("Automatic backup failed:", error);
    }
  };
  void snapshot();
  const timer = setInterval(snapshot, 5 * 60_000);

  const stop = async () => {
    clearInterval(timer);
    await server.stop();
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

const SNAPSHOT = /^clearance-\d{8}T\d{6}Z\.ndjson\.gz$/;

/** The automatic backups on disk, newest first. Other files in the directory are left alone. */
function listSnapshots(dir: string): Snapshot[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => SNAPSHOT.test(name))
    .map((name) => {
      const stat = statSync(join(dir, name));
      return { name, bytes: stat.size, at: stat.mtime.toISOString() };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

/** Written under a temporary name first, so a half-written file is never mistaken for a backup. */
async function writeBackup(ctx: ReturnType<typeof createCtx>, file: string) {
  mkdirSync(dirname(file), { recursive: true });
  const partial = `${file}.partial`;
  await Bun.write(partial, new Response(exportBackup(ctx)));
  renameSync(partial, file);
}

async function hash(args: string[]) {
  const [markdown, fieldsFile] = args;
  if (!markdown || !existsSync(markdown)) {
    console.error(USAGE);
    process.exit(2);
  }
  const { title, body } = fromMarkdownFile(readFileSync(markdown, "utf8"));
  if (!title) {
    console.error(`${markdown} must start with a "# Title" line.`);
    process.exit(2);
  }
  const fields = fieldsSchema.safeParse(
    fieldsFile ? JSON.parse(readFileSync(fieldsFile, "utf8")) : [],
  );
  if (!fields.success) {
    console.error(
      fields.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n"),
    );
    process.exit(2);
  }
  console.log(await documentFingerprint({ title, body, fields: fields.data }));
}

/**
 * The way back in for an administrator who has lost every passkey. Whoever can
 * run this already has the database, so it grants nothing they lack.
 */
async function recoveryLink(ctx: ReturnType<typeof createCtx>, name: string) {
  let query = ctx.db
    .selectFrom("users")
    .selectAll()
    .where("is_admin", "=", 1)
    .where("disabled_at", "is", null)
    .orderBy("created_at");
  if (name) query = query.where("name", "=", name);
  const admin = await query.executeTakeFirst();
  if (!admin) {
    console.error(
      name
        ? `No administrator is named "${name}".`
        : "There is no administrator yet.",
    );
    process.exit(1);
  }
  const { origin } = await getSettings(ctx);
  const { token, query: insert } = await createInvite(ctx, {
    kind: "passkey",
    createdBy: admin.id,
    targetUserId: admin.id,
    expiresAt: addDays(ctx.now(), 1),
    maxUses: 1,
  });
  await ctx.store.atomic([
    insert,
    audit(
      ctx,
      {
        user: null,
        ip: "",
        userAgent: "clearance recovery-link",
        origin: null,
      },
      "invite.create",
      "user",
      admin.id,
      { kind: "passkey", via: "command line" },
    ),
  ]);
  console.log(`A new-passkey link for ${admin.name}. It works once and expires in a day:
`);
  console.log(`  ${origin ?? "https://YOUR-SITE"}/join/${token}
`);
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
