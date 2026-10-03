import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, TestClient } from "./helpers/harness.ts";

// Cloudflare Workers with D1, for real: this starts `wrangler dev`, which runs
// the Worker entry point in workerd against a local D1, and drives it over
// HTTP. It is what covers the D1 driver, the batch-based `atomic`, and the
// code paths (PDF, WebAuthn, gzip) running outside Bun.

const root = join(import.meta.dir, "..");

interface Worker {
  origin: string;
  stop(): Promise<void>;
}

async function startWorker(port: number): Promise<Worker> {
  const state = mkdtempSync(join(tmpdir(), "clearance-worker-"));
  const origin = `http://localhost:${port}`;
  const wrangler = Bun.spawn(
    [
      "bun",
      "x",
      "wrangler",
      "dev",
      "--port",
      String(port),
      // Each instance needs its own debugger port, or the second fails to
      // start. Well away from the port itself: on Windows, Hyper-V reserves
      // moving ranges around 9700-11400, and port + 1000 landed in one.
      "--inspector-port",
      String(port + 20000),
      "--persist-to",
      state,
      "--log-level",
      "warn",
    ],
    { cwd: root, stdio: ["ignore", "inherit", "inherit"] },
  );

  const stop = async () => {
    // Wrangler runs workerd as a grandchild. On Windows, killing the parent
    // alone leaves workerd holding the port, so take the whole tree down.
    if (process.platform === "win32") {
      await Bun.spawn(["taskkill", "/PID", String(wrangler.pid), "/T", "/F"], {
        stdio: ["ignore", "ignore", "ignore"],
      }).exited;
    } else {
      wrangler.kill();
    }
    await wrangler.exited;
    // Windows releases the database files a moment after the process is gone.
    // A leftover temp directory is not worth failing the run over.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        rmSync(state, { recursive: true, force: true });
        break;
      } catch {
        await Bun.sleep(250);
      }
    }
  };

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const ready = await fetch(`${origin}/api/state`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) return { origin, stop };
    await Bun.sleep(500);
  }
  await stop();
  throw new Error("wrangler dev did not start");
}

let worker: Worker;
let second: Worker | undefined;

beforeAll(async () => {
  // Wrangler refuses to start without the assets directory; the API does not need its contents.
  const assets = join(root, "dist/client");
  if (!existsSync(assets)) {
    mkdirSync(assets, { recursive: true });
    writeFileSync(
      join(assets, "index.html"),
      "<!doctype html><title>Clearance</title>",
    );
  }
  worker = await startWorker(8797);
}, 150_000);

afterAll(async () => {
  await worker?.stop();
  await second?.stop();
}, 60_000);

test("the Worker runs setup, groups, signing, PDF and backups on D1", async () => {
  const ORIGIN = worker.origin;
  const client = () => new TestClient((request) => fetch(request), "", ORIGIN);

  const admin = client();
  expect((await admin.ok("GET", "/state")).setupNeeded).toBe(true);
  expect((await admin.register({ name: "Ada Admin" })).status).toBe(200);
  expect((await admin.ok("GET", "/state")).me).toMatchObject({
    name: "Ada Admin",
    admin: true,
  });

  await admin.ok("PATCH", "/admin/settings", {
    minorsEnabled: true,
    timezone: "America/Los_Angeles",
  });
  const group = await admin.ok("POST", "/groups", {
    name: "Team 100",
    code: "100",
  });
  const link = await admin.ok("POST", `/groups/${group.id}/invites`, {
    kind: "group_member",
    maxUses: 2,
  });
  const clearance = await admin.ok("POST", "/clearances", {
    name: "General release",
    requiredForAll: true,
  });
  await admin.ok("POST", `/clearances/${clearance.id}/versions`, {
    title: "Shop release",
    body: "# Shop release\n\nThe shop has **sharp tools**.\n\n- Wear safety glasses.\n",
    fields: [
      {
        key: "contact",
        label: "Emergency contact",
        type: "text",
        required: true,
      },
    ],
  });

  // A parent enrols a child and signs for them: a conditional UPDATE (the
  // link's use count) followed by multi-statement batches.
  const parent = client();
  expect(
    (
      await parent.register({
        invite: link.token,
        name: "Pat Parent",
        adult: true,
        as: "guardian",
      })
    ).status,
  ).toBe(200);
  const child = await parent.ok("POST", "/family/wards", {
    name: "Kit Kid",
    birthdate: "2012-05-04",
    invite: link.token,
  });
  const signed = await parent.sign(clearance.id, child.id, {
    contact: "Pat 555-0100",
  });
  expect(signed.status).toBe(200);
  expect(signed.body.granted).toBe(true);

  const pdf = await parent.get(`/signatures/${signed.body.signatureId}/pdf`);
  expect(pdf.response.headers.get("content-type")).toBe("application/pdf");
  const pdfBytes = new Uint8Array(await pdf.response.arrayBuffer());
  expect(new TextDecoder().decode(pdfBytes.slice(0, 5))).toBe("%PDF-");

  const roster = await admin.ok("GET", `/groups/${group.id}`);
  expect(roster.members).toHaveLength(1);
  expect(roster.members[0]).toMatchObject({ name: "Kit Kid", minor: true });
  expect(roster.members[0].clearances[0]).toMatchObject({ state: "active" });

  // The link allowed two uses; the child took one, a member takes the last.
  expect(
    (await client().register({ invite: link.token, name: "Sam", adult: true }))
      .status,
  ).toBe(200);
  expect(
    (await client().register({ invite: link.token, name: "Late", adult: true }))
      .status,
  ).toBe(410);

  // Sessions and sign-in work across requests.
  await parent.logout();
  expect((await parent.get("/family")).status).toBe(401);
  expect((await parent.login()).status).toBe(200);

  // There is no disk for automatic backups here, and the UI is told so.
  expect(await admin.ok("GET", "/admin/backups")).toMatchObject({
    automatic: false,
    snapshots: [],
  });

  // --- Moving the installation: D1 → SQLite, and D1 → a second, empty D1 ------
  const download = await admin.get("/admin/backup");
  const backup = new Uint8Array(await download.response.arrayBuffer());
  expect([backup[0], backup[1]]).toEqual([0x1f, 0x8b]);

  /** After a restore, people sign in with the passkeys they already had. */
  async function expectSameInstallation(make: () => TestClient) {
    const pat = make();
    pat.authenticator = parent.authenticator;
    expect((await pat.login()).body.userId).toBe(parent.userId!);
    const family = await pat.ok("GET", "/family");
    expect(family.wards[0]).toMatchObject({ name: "Kit Kid" });
    expect(family.wards[0].clearances[0]).toMatchObject({ state: "active" });
    const copy = await pat.get(`/signatures/${signed.body.signatureId}/pdf`);
    expect(new Uint8Array(await copy.response.arrayBuffer())).toEqual(pdfBytes);
  }

  const sqlite = await createHarness("sqlite");
  try {
    const viaSqlite = () =>
      new TestClient((request) => sqlite.api.fetch(request), "", ORIGIN);
    const restored = await viaSqlite().request(
      "POST",
      "/setup/restore",
      backup,
    );
    expect(restored.status).toBe(200);
    expect(restored.body.restored).toMatchObject({ users: 4, signatures: 1 });
    await expectSameInstallation(viaSqlite);
  } finally {
    await sqlite.close();
  }

  second = await startWorker(8798);
  // The backup says the site lives at the first Worker's address, and passkeys
  // are bound to its hostname. Both are "localhost" here, so only the port in
  // the URL differs; the browser-reported origin stays the original one.
  const viaSecond = () =>
    new TestClient(
      (request) =>
        fetch(
          new Request(request.url.replace(ORIGIN, second!.origin), request),
        ),
      "",
      ORIGIN,
    );
  const restored = await viaSecond().request("POST", "/setup/restore", backup);
  expect(restored.status).toBe(200);
  expect(restored.body).toMatchObject({ origin: ORIGIN });
  await expectSameInstallation(viaSecond);
}, 300_000);
