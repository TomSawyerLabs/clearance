import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestClient } from "./helpers/harness.ts";

// The Bun entry point as an operator meets it: a server process on a file
// database, and the command-line tools run against that same file.

const PORT = 8796;
const ORIGIN = `http://localhost:${PORT}`;
const entry = join(import.meta.dir, "../src/entry/bun.ts");
const dir = mkdtempSync(join(tmpdir(), "clearance-cli-"));
const env = {
  ...process.env,
  DATABASE_URL: `sqlite:${join(dir, "clearance.db")}`,
  PORT: String(PORT),
};
let server: Bun.Subprocess | undefined;

async function cli(...args: string[]) {
  const child = Bun.spawn(["bun", entry, ...args], {
    env,
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

beforeAll(async () => {
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
}, 30_000);

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
