import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestClient } from "./helpers/harness.ts";

// The Bun entry point as an operator meets it: a server process on a file
// database, and the command-line tools run against that same file.

const PORT = 8796;
const ORIGIN = `http://localhost:${PORT}`;
const entry = join(import.meta.dir, "../src/entry/bun.ts");
const dir = mkdtempSync(join(tmpdir(), "clearance-cli-"));
const env: Record<string, string | undefined> = {
  ...process.env,
  DATABASE_URL: `sqlite:${join(dir, "clearance.db")}`,
  PORT: String(PORT),
};
let server: Bun.Subprocess | undefined;

async function cli(...args: string[]) {
  return cliWith(env, ...args);
}

async function cliWith(
  environment: Record<string, string | undefined>,
  ...args: string[]
) {
  const child = Bun.spawn(["bun", entry, ...args], {
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

async function startServer() {
  server = Bun.spawn(["bun", entry], {
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = await fetch(`${ORIGIN}/api/state`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) return;
    await Bun.sleep(100);
  }
  throw new Error("the server did not start");
}

beforeAll(startServer, 30_000);

afterAll(async () => {
  server?.kill();
  await server?.exited;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
});

test("an operator recovers a locked-out administrator and edits settings", async () => {
  const client = () => new TestClient((request) => fetch(request), "", ORIGIN);

  expect((await cli("recovery-link")).code).toBe(1);

  const admin = client();
  expect((await admin.register({ name: "Ada Admin" })).status).toBe(200);
  // With no proxy header configured, the address is the socket's.
  const audit = await admin.ok("GET", "/admin/audit");
  expect(audit[0].ip).toMatch(/127\.0\.0\.1|::1/);

  const recovery = await cli("recovery-link");
  expect(recovery.code).toBe(0);
  const token = recovery.stdout.match(/\/join\/(\S+)/)?.[1];
  expect(recovery.stdout).toContain(`${ORIGIN}/join/`);

  const newDevice = client();
  expect((await newDevice.register({ invite: token })).status).toBe(200);
  expect(newDevice.userId).toBe(admin.userId);
  expect((await client().register({ invite: token })).status).toBe(410);

  expect((await cli("config", "set", "siteName", "Tom Sawyer Labs")).code).toBe(
    0,
  );
  expect((await cli("config", "set", "adultAge", "200")).code).toBe(2);
  expect(JSON.parse((await cli("config")).stdout)).toMatchObject({
    siteName: "Tom Sawyer Labs",
    origin: ORIGIN,
  });
  expect((await admin.ok("GET", "/state")).site.name).toBe("Tom Sawyer Labs");
}, 60_000);

test("an operator backs up, restores elsewhere, and matches a document to its files", async () => {
  const admin = new TestClient((request) => fetch(request), "", ORIGIN);
  // The administrator from the previous test; their recovery passkey is not
  // needed, a fresh link gives this client its own.
  const token = (await cli("recovery-link")).stdout.match(/\/join\/(\S+)/)?.[1];
  expect((await admin.register({ invite: token })).status).toBe(200);

  // --- A document written as files, then published -------------------------
  const markdown = join(dir, "release.md");
  const fieldsFile = join(dir, "release.fields.json");
  const fields = [
    {
      key: "contact",
      label: "Emergency contact",
      type: "text",
      required: true,
    },
  ];
  // CRLF, as a Windows checkout would have it.
  writeFileSync(
    markdown,
    "# Shop release\r\n\r\nThe shop has **sharp tools**.\r\n",
  );
  writeFileSync(fieldsFile, JSON.stringify(fields, null, 2));
  const hashed = await cli("hash", markdown, fieldsFile);
  expect(hashed.code).toBe(0);
  expect(hashed.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);

  const clearance = await admin.ok("POST", "/clearances", {
    name: "General release",
  });
  const published = await admin.ok(
    "POST",
    `/clearances/${clearance.id}/versions`,
    {
      title: "Shop release",
      body: "The shop has **sharp tools**.",
      fields,
    },
  );
  expect(published.bodyHash).toBe(hashed.stdout.trim());
  // A file with no title line cannot be fingerprinted.
  writeFileSync(join(dir, "untitled.md"), "Just text.\n");
  expect((await cli("hash", join(dir, "untitled.md"))).code).toBe(2);

  // --- A backup, restored into a second installation ------------------------
  const file = join(dir, "moved.ndjson.gz");
  const backup = await cli("backup", file);
  expect(backup.code).toBe(0);
  expect(backup.stdout.trim()).toBe(file);

  const elsewhere = {
    ...env,
    DATABASE_URL: `sqlite:${join(dir, "elsewhere", "clearance.db")}`,
  };
  const restored = await cliWith(elsewhere, "restore", file);
  expect(restored.code).toBe(0);
  expect(restored.stdout).toContain('"document_versions":1');
  expect(JSON.parse((await cliWith(elsewhere, "config")).stdout)).toMatchObject(
    {
      siteName: "Tom Sawyer Labs",
      origin: ORIGIN,
    },
  );
  // It only goes into an empty installation.
  const again = await cliWith(elsewhere, "restore", file);
  expect(again.code).toBe(1);
  expect(again.stderr).toContain("empty installation");

  // --- Automatic backups: one is written when the server starts with data ----
  expect(await admin.ok("GET", "/admin/backups")).toMatchObject({
    automatic: true,
    everyHours: 24,
    snapshots: [],
  });
  server?.kill();
  await server?.exited;
  // Restarted as it would run behind a reverse proxy.
  env.CLIENT_IP_HEADER = "X-Test-IP";
  await startServer();
  const viaProxy = new TestClient(
    (request) => fetch(request),
    "198.51.100.7",
    ORIGIN,
  );
  viaProxy.authenticator = admin.authenticator;
  expect((await viaProxy.login()).status).toBe(200);
  await viaProxy.ok("PATCH", "/admin/settings", { sessionDays: 31 });
  // The address on the record is the one the proxy reported, not the socket's.
  expect((await viaProxy.ok("GET", "/admin/audit"))[0]).toMatchObject({
    action: "settings.update",
    ip: "198.51.100.7",
  });
  let snapshots: { name: string; bytes: number }[] = [];
  for (let attempt = 0; attempt < 50 && snapshots.length === 0; attempt++) {
    await Bun.sleep(100);
    snapshots = (await admin.ok("GET", "/admin/backups")).snapshots;
  }
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]!.bytes).toBeGreaterThan(100);
  // Beside the database, under its final name only.
  expect(readdirSync(join(dir, "backups"))).toEqual([snapshots[0]!.name]);
}, 90_000);
