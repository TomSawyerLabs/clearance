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
import { TestClient } from "./helpers/harness.ts";

// Cloudflare Workers with D1, for real: this starts `wrangler dev`, which runs
// the Worker entry point in workerd against a local D1, and drives it over
// HTTP. It is what covers the D1 driver, the batch-based `atomic`, and the
// code paths (PDF, WebAuthn) running outside Bun.

const PORT = 8797;
const ORIGIN = `http://localhost:${PORT}`;
const root = join(import.meta.dir, "..");
const state = mkdtempSync(join(tmpdir(), "clearance-worker-"));
let wrangler: Bun.Subprocess | undefined;

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
  wrangler = Bun.spawn(
    [
      "bun",
      "x",
      "wrangler",
      "dev",
      "--port",
      String(PORT),
      "--persist-to",
      state,
      "--log-level",
      "warn",
    ],
    { cwd: root, stdio: ["ignore", "inherit", "inherit"] },
  );
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const ready = await fetch(`${ORIGIN}/api/state`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) return;
    await Bun.sleep(500);
  }
  throw new Error("wrangler dev did not start");
}, 150_000);

afterAll(async () => {
  if (wrangler) {
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
  }
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
}, 30_000);

test("the Worker runs setup, groups, signing and PDF on D1", async () => {
  const client = () => new TestClient((request) => fetch(request), "", ORIGIN);

  const admin = client();
  expect((await admin.ok("GET", "/state")).setupNeeded).toBe(true);
  expect((await admin.register({ name: "Ada Admin" })).status).toBe(200);
  expect((await admin.ok("GET", "/state")).me).toMatchObject({
    name: "Ada Admin",
    admin: true,
  });

  await admin.ok("PATCH", "/admin/settings", {
    guardiansEnabled: true,
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
  expect(
    new TextDecoder().decode((await pdf.response.arrayBuffer()).slice(0, 5)),
  ).toBe("%PDF-");

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
}, 120_000);
