import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { fromBase64Url, sha256, toBase64Url } from "../src/server/lib/util.ts";
import {
  documentFingerprint,
  fromMarkdownFile,
} from "../src/shared/documentFile.ts";
import {
  createHarness,
  ENGINES,
  type Harness,
  prepareEngine,
  type TestClient,
} from "./helpers/harness.ts";

// Every scenario runs against every database engine through the real HTTP
// handler, with software passkeys standing in for browsers.

const DOCUMENT = {
  title: "Shop release",
  body: "# Shop release\n\nI understand the **risks** of the shop.\n\n1. Follow the rules.\n2. Wear safety glasses.\n",
  fields: [
    {
      key: "emergency_contact",
      label: "Emergency contact",
      type: "text",
      required: true,
    },
    { key: "photos", label: "Photos may be used", type: "checkbox" },
    {
      key: "read_rules",
      label: "I have read the safety rules",
      type: "acknowledge",
    },
    {
      key: "student_rules",
      label: "I will follow the safety rules",
      type: "acknowledge",
      audience: "minor",
    },
  ],
};
const ANSWERS = {
  emergency_contact: "Pat 555-0100",
  photos: true,
  read_rules: true,
};

for (const engine of ENGINES) {
  describe(engine, () => {
    let h: Harness;
    let admin: TestClient;

    beforeAll(() => prepareEngine(engine), 180_000);
    beforeEach(async () => {
      h = await createHarness(engine);
      admin = h.client();
      expect((await admin.register({ name: "Ada Admin" })).status).toBe(200);
    });
    afterEach(() => h.close());

    /** A group plus one reusable link of each kind. */
    async function makeGroup(name = "Team 100", code = "100") {
      const { id } = await admin.ok("POST", "/groups", { name, code });
      const member = await admin.ok("POST", `/groups/${id}/invites`, {
        kind: "group_member",
      });
      const manager = await admin.ok("POST", `/groups/${id}/invites`, {
        kind: "group_manager",
      });
      return {
        id,
        memberLink: member.token as string,
        managerLink: manager.token as string,
      };
    }

    async function makeClearance(overrides: Record<string, unknown> = {}) {
      const clearance = await admin.ok("POST", "/clearances", {
        name: "General release",
        requiredForAll: true,
        ...overrides,
      });
      await admin.ok("POST", `/clearances/${clearance.id}/versions`, DOCUMENT);
      return clearance.id as string;
    }

    async function join(link: string, input: Record<string, unknown>) {
      const client = h.client();
      const reply = await client.register({ invite: link, ...input });
      expect(reply.status).toBe(200);
      return client;
    }

    async function statusOf(
      viewer: TestClient,
      userId: string,
      clearanceId: string,
    ) {
      const person = await viewer.ok("GET", `/people/${userId}`);
      return person.clearances.find((c: any) => c.clearanceId === clearanceId);
    }

    test("the first person to register becomes the administrator, and only them", async () => {
      const state = await admin.ok("GET", "/state");
      expect(state.setupNeeded).toBe(false);
      expect(state.me).toMatchObject({ name: "Ada Admin", admin: true });
      expect((await admin.ok("GET", "/admin/settings")).origin).toBe(
        "https://clearance.test",
      );

      // After setup an account needs a link.
      const stranger = h.client();
      const refused = await stranger.register({ name: "Mallory" });
      expect(refused.status).toBe(403);
      expect((await stranger.ok("GET", "/state")).me).toBeNull();
    });

    test("signing in, signing out, and passkey housekeeping", async () => {
      await admin.logout();
      expect((await admin.get("/groups")).status).toBe(401);
      expect((await admin.login()).status).toBe(200);
      expect((await admin.get("/groups")).status).toBe(200);

      const passkeys = await admin.ok("GET", "/me/passkeys");
      expect(passkeys).toHaveLength(1);
      // The only way in cannot be removed.
      expect(
        (await admin.request("DELETE", `/me/passkeys/${passkeys[0].id}`))
          .status,
      ).toBe(409);

      // A signed-in person adds a second passkey, then the first can go.
      expect((await admin.register({})).status).toBe(200);
      expect(await admin.ok("GET", "/me/passkeys")).toHaveLength(2);
      expect(
        (await admin.request("DELETE", `/me/passkeys/${passkeys[0].id}`))
          .status,
      ).toBe(200);
    });

    test("requests from another origin are refused", async () => {
      const response = await h.api.fetch(
        new Request("https://clearance.test/api/auth/logout", {
          method: "POST",
          headers: { origin: "https://evil.test" },
        }),
      );
      expect(response.status).toBe(403);
    });

    test("groups: managers join by link, hand out links, and see their members", async () => {
      const group = await makeGroup();
      const mentor = await join(group.managerLink, { name: "Mo Mentor" });

      const oneUse = await mentor.ok("POST", `/groups/${group.id}/invites`, {
        kind: "group_member",
        maxUses: 1,
      });
      const described = await h.client().ok("GET", `/invites/${oneUse.token}`);
      expect(described).toMatchObject({
        kind: "group_member",
        inviterName: "Mo Mentor",
      });
      expect(described.group).toMatchObject({ name: "Team 100", code: "100" });

      const student = await join(oneUse.token, { name: "Sam Student" });
      const late = await h
        .client()
        .register({ invite: oneUse.token, name: "Late Larry" });
      expect(late.status).toBe(410);

      const view = await mentor.ok("GET", `/groups/${group.id}`);
      expect(view.members.map((m: any) => [m.name, m.role])).toEqual([
        ["Mo Mentor", "manager"],
        ["Sam Student", "member"],
      ]);
      // A plain member cannot see the roster or mint links.
      expect((await student.get(`/groups/${group.id}`)).status).toBe(403);
      expect(
        (
          await student.post(`/groups/${group.id}/invites`, {
            kind: "group_member",
          })
        ).status,
      ).toBe(403);
      // Nor see a stranger's records, though their manager can.
      expect((await student.get(`/people/${admin.userId}`)).status).toBe(403);
      expect((await mentor.get(`/people/${student.userId}`)).status).toBe(200);

      // A revoked link stops working.
      const links = (await mentor.ok("GET", `/groups/${group.id}`)).invites;
      const memberLink = links.find((l: any) => l.token === group.memberLink);
      await mentor.ok("DELETE", `/invites/${memberLink.id}`);
      expect(
        (await h.client().get(`/invites/${group.memberLink}`)).status,
      ).toBe(410);
    });

    test("an adult signs a release with a passkey and gets a verifiable record", async () => {
      const group = await makeGroup();
      const clearanceId = await makeClearance({ validityDays: 365 });
      const member = await join(group.memberLink, { name: "Renée O’Brien" });
      const me = member.userId!;

      expect(await statusOf(member, me, clearanceId)).toMatchObject({
        state: "missing",
        waitingOn: ["self"],
        required: true,
      });

      // A required answer is missing, so no passkey prompt is even issued.
      const incomplete = await member.sign(clearanceId, me, {
        read_rules: true,
      });
      expect(incomplete.status).toBe(400);
      expect(incomplete.body.details).toHaveProperty("emergency_contact");

      const signed = await member.sign(clearanceId, me, ANSWERS);
      expect(signed.status).toBe(200);
      expect(signed.body.granted).toBe(true);
      expect(await statusOf(member, me, clearanceId)).toMatchObject({
        state: "active",
        waitingOn: [],
      });

      // The record is self-contained evidence: the passkey signed the hash of
      // exactly this record, and the public key travels with it.
      const record = await member.ok(
        "GET",
        `/signatures/${signed.body.signatureId}`,
      );
      expect(record.record).toMatchObject({
        capacity: "self",
        answers: ANSWERS,
        signer: { name: "Renée O’Brien" },
        document: { version: 1, title: "Shop release" },
      });
      const expected = toBase64Url(
        await sha256(record.evidence.canonicalRecord),
      );
      const clientData = JSON.parse(
        new TextDecoder().decode(fromBase64Url(record.evidence.clientDataJSON)),
      );
      expect(clientData.challenge).toBe(expected);
      expect(record.evidence.challenge).toBe(expected);
      expect(record.evidence.publicKey).toBeTruthy();

      const pdf = await member.get(
        `/signatures/${signed.body.signatureId}/pdf`,
      );
      expect(pdf.response.headers.get("content-type")).toBe("application/pdf");
      const bytes = new Uint8Array(await pdf.response.arrayBuffer());
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");

      // Already current: nothing to sign.
      expect((await member.sign(clearanceId, me, ANSWERS)).status).toBe(403);
      // Someone unrelated cannot read the record; the group's manager can.
      const other = await join(group.memberLink, { name: "Other" });
      expect(
        (await other.get(`/signatures/${signed.body.signatureId}`)).status,
      ).toBe(403);
      const mentor = await join(group.managerLink, { name: "Mo Mentor" });
      expect(
        (await mentor.get(`/signatures/${signed.body.signatureId}/pdf`)).status,
      ).toBe(200);

      // It lapses after its validity period and can then be signed again.
      h.advance(366);
      await member.login();
      await mentor.login();
      await admin.login();
      expect(await statusOf(member, me, clearanceId)).toMatchObject({
        state: "expired",
      });
      expect((await member.sign(clearanceId, me, ANSWERS)).body.granted).toBe(
        true,
      );
      expect(await statusOf(member, me, clearanceId)).toMatchObject({
        state: "active",
      });

      // A new version of the text makes the old signature stale...
      await admin.ok("POST", `/clearances/${clearanceId}/versions`, {
        ...DOCUMENT,
        body: `${DOCUMENT.body}\n3. No open-toed shoes.\n`,
      });
      const stale = await statusOf(member, me, clearanceId);
      expect(stale.state).toBe("stale");
      expect(stale.reason).toContain("changed");
      // ...unless it is published as a correction.
      const resign = await member.sign(clearanceId, me, ANSWERS);
      expect(resign.body.granted).toBe(true);
      await admin.ok("POST", `/clearances/${clearanceId}/versions`, {
        ...DOCUMENT,
        supersedes: false,
      });
      expect(await statusOf(member, me, clearanceId)).toMatchObject({
        state: "active",
      });

      // A manager can revoke, and that is audited.
      const grantId = (await statusOf(member, me, clearanceId)).grantId;
      await mentor.ok("POST", `/grants/${grantId}/revoke`, {
        reason: "Withdrawn",
      });
      expect((await statusOf(member, me, clearanceId)).state).not.toBe(
        "active",
      );
      const audit = await admin.ok("GET", "/admin/audit");
      expect(audit.map((entry: any) => entry.action)).toContain("grant.revoke");
    });

    test("a signing response cannot be replayed or redirected", async () => {
      const group = await makeGroup();
      const clearanceId = await makeClearance();
      const member = await join(group.memberLink, { name: "Sam" });

      const started = await member.ok("POST", "/sign/options", {
        clearanceId,
        subjectId: member.userId,
        answers: ANSWERS,
      });
      const response = await member.authenticator.get(started.options);
      const payload = { challengeId: started.challengeId, response };

      // Another signed-in person cannot submit it as theirs.
      const other = await join(group.memberLink, { name: "Other" });
      expect((await other.post("/sign/verify", payload)).status).toBe(403);
      // The challenge is spent now, even for its owner.
      expect((await member.post("/sign/verify", payload)).status).toBe(410);
      expect(
        (await member.ok("GET", `/people/${member.userId}`)).signatures,
      ).toHaveLength(0);
    });

    test("guardians: a parent enrols a child and signs for them", async () => {
      await admin.ok("PATCH", "/admin/settings", { guardiansEnabled: true });
      const group = await makeGroup();
      const clearanceId = await makeClearance();

      // The parent uses the team's link to enrol a child, not to join.
      const parent = await join(group.memberLink, {
        name: "Pat Parent",
        adult: true,
        as: "guardian",
      });
      const child = await parent.ok("POST", "/family/wards", {
        name: "Kit Kid",
        birthdate: "2012-05-04",
        invite: group.memberLink,
      });

      const roster = (await admin.ok("GET", `/groups/${group.id}`)).members;
      expect(roster.map((m: any) => m.name)).toEqual(["Kit Kid"]);
      expect(roster[0]).toMatchObject({
        minor: true,
        managed: true,
        needsGuardian: false,
      });
      expect(roster[0].guardians).toMatchObject([
        { name: "Pat Parent", verified: false },
      ]);

      const family = await parent.ok("GET", "/family");
      expect(family.wards).toHaveLength(1);
      expect(family.wards[0].clearances[0]).toMatchObject({
        state: "missing",
        waitingOn: ["guardian"],
      });

      const signed = await parent.sign(clearanceId, child.id, ANSWERS);
      expect(signed.status).toBe(200);
      expect(signed.body.granted).toBe(true);
      const record = await parent.ok(
        "GET",
        `/signatures/${signed.body.signatureId}`,
      );
      expect(record.record).toMatchObject({
        capacity: "guardian",
        subject: { name: "Kit Kid", birthdate: "2012-05-04" },
        signer: { name: "Pat Parent" },
      });

      // A manager records having checked who the parent is.
      const mentor = await join(group.managerLink, {
        name: "Mo Mentor",
        adult: true,
      });
      await mentor.ok(
        "PUT",
        `/guardianships/${roster[0].guardians[0].guardianshipId}/verified`,
        {
          verified: true,
        },
      );
      const after = (await mentor.ok("GET", `/groups/${group.id}`)).members[0];
      expect(after.guardians[0].verified).toBe(true);

      // The child later takes over the account with a link from the parent.
      const claim = await parent.ok(
        "POST",
        `/family/wards/${child.id}/claim-invite`,
      );
      const kid = h.client();
      expect((await kid.register({ invite: claim.token })).status).toBe(200);
      expect(kid.userId).toBe(child.id);
      expect((await kid.ok("GET", "/state")).me).toMatchObject({
        name: "Kit Kid",
        managed: false,
      });
      expect((await h.client().register({ invite: claim.token })).status).toBe(
        410,
      );

      // On their 18th birthday the guardian's signature stops being enough.
      h.advance(365 * 5);
      await kid.login();
      await parent.login();
      const grown = await statusOf(kid, child.id, clearanceId);
      expect(grown).toMatchObject({ state: "stale", waitingOn: ["self"] });
      expect((await parent.sign(clearanceId, child.id, ANSWERS)).status).toBe(
        403,
      );
      expect(
        (await kid.sign(clearanceId, child.id, ANSWERS)).body.granted,
      ).toBe(true);
    });

    test("guardians: a student signs up first and brings in a parent", async () => {
      await admin.ok("PATCH", "/admin/settings", { guardiansEnabled: true });
      const group = await makeGroup();
      const clearanceId = await makeClearance({
        minorPolicy: "guardian_and_minor",
      });

      // Being a minor has to come with a date of birth.
      const vague = await h
        .client()
        .register({ invite: group.memberLink, name: "Sam", adult: false });
      expect(vague.status).toBe(400);
      const student = await join(group.memberLink, {
        name: "Sam Student",
        adult: false,
        birthdate: "2011-01-15",
      });
      expect((await student.ok("GET", "/state")).me).toMatchObject({
        minor: true,
        needsGuardian: true,
      });

      // Both have to sign. The student signs their own part...
      const mine = await student.sign(clearanceId, student.userId!, {
        student_rules: true,
      });
      expect(mine.status).toBe(200);
      expect(mine.body.granted).toBe(false);
      expect(
        await statusOf(student, student.userId!, clearanceId),
      ).toMatchObject({
        state: "pending",
        waitingOn: ["guardian"],
        signed: ["minor"],
      });
      expect(
        (
          await student.sign(clearanceId, student.userId!, {
            student_rules: true,
          })
        ).status,
      ).toBe(403);

      // ...and sends a link to a parent, who makes an account from it.
      const link = await student.ok("POST", "/family/guardian-invite");
      const described = await h.client().ok("GET", `/invites/${link.token}`);
      expect(described).toMatchObject({
        kind: "guardian",
        targetName: "Sam Student",
      });
      // A minor cannot be anyone's guardian.
      const sibling = await h.client().register({
        invite: link.token,
        name: "Sib",
        adult: false,
        birthdate: "2010-01-01",
      });
      expect(sibling.status).toBe(403);
      const parent = await join(link.token, {
        name: "Pat Parent",
        adult: true,
      });

      expect((await student.ok("GET", "/state")).me.needsGuardian).toBe(false);
      const done = await parent.sign(clearanceId, student.userId!, ANSWERS);
      expect(done.body.granted).toBe(true);
      expect(
        await statusOf(parent, student.userId!, clearanceId),
      ).toMatchObject({ state: "active" });

      // A second parent who already has an account accepts the same link.
      const second = await join(group.managerLink, {
        name: "Mo Mentor",
        adult: true,
      });
      expect((await second.post(`/invites/${link.token}/accept`)).status).toBe(
        200,
      );
      expect(
        (await second.ok("GET", "/family")).wards.map((w: any) => w.name),
      ).toEqual(["Sam Student"]);

      // The parent is not in the group, and so has no view of anyone else.
      expect((await parent.get(`/groups/${group.id}`)).status).toBe(403);
    });

    test("administration: settings, recovery links, and turning accounts off", async () => {
      const group = await makeGroup();
      const member = await join(group.memberLink, { name: "Sam" });

      expect(
        (await member.request("PATCH", "/admin/settings", { siteName: "Mine" }))
          .status,
      ).toBe(403);
      expect(
        (
          await admin.request("PATCH", "/admin/settings", {
            timezone: "Mars/Olympus",
          })
        ).status,
      ).toBe(400);
      const settings = await admin.ok("PATCH", "/admin/settings", {
        siteName: "Tom Sawyer Labs",
        timezone: "America/Los_Angeles",
      });
      expect(settings).toMatchObject({
        siteName: "Tom Sawyer Labs",
        timezone: "America/Los_Angeles",
      });
      expect((await member.ok("GET", "/state")).site.name).toBe(
        "Tom Sawyer Labs",
      );

      // A lost passkey: the admin issues a link, a new device takes over.
      expect(
        (await member.post(`/admin/users/${member.userId}/passkey-invite`))
          .status,
      ).toBe(403);
      const recovery = await admin.ok(
        "POST",
        `/admin/users/${member.userId}/passkey-invite`,
      );
      const newDevice = h.client();
      expect(
        (await newDevice.register({ invite: recovery.token })).status,
      ).toBe(200);
      expect(newDevice.userId).toBe(member.userId);

      const users = await admin.ok("GET", "/admin/users");
      expect(users.find((u: any) => u.id === member.userId).passkeys).toBe(2);

      // Turning an account off ends its sessions and blocks new sign-ins.
      await admin.ok("PATCH", `/admin/users/${member.userId}`, {
        disabled: true,
      });
      expect((await member.get("/groups")).status).toBe(401);
      expect((await member.login()).status).toBe(403);
      // An administrator cannot lock themself out.
      expect(
        (
          await admin.request("PATCH", `/admin/users/${admin.userId}`, {
            admin: false,
          })
        ).status,
      ).toBe(409);
    });

    test("a published document's fingerprint can be reproduced from its files", async () => {
      const clearance = await admin.ok("POST", "/clearances", { name: "R" });
      // As the files would be on Windows: CRLF line endings, a trailing newline.
      const published = await admin.ok(
        "POST",
        `/clearances/${clearance.id}/versions`,
        {
          title: " Shop release ",
          body: "# Risks\r\n\r\nSharp **tools**.\r\n",
          fields: DOCUMENT.fields,
        },
      );
      expect(published.body).toBe("# Risks\n\nSharp **tools**.");
      expect(published.title).toBe("Shop release");
      const fromFile = fromMarkdownFile(
        "# Shop release\n\n# Risks\n\nSharp **tools**.\n",
      );
      expect(fromFile).toEqual({
        title: "Shop release",
        body: "# Risks\n\nSharp **tools**.",
      });
      expect(published.bodyHash).toBe(
        await documentFingerprint({
          title: fromFile.title!,
          body: fromFile.body,
          fields: DOCUMENT.fields as never,
        }),
      );
      // One changed word is a different document.
      expect(published.bodyHash).not.toBe(
        await documentFingerprint({
          title: "Shop release",
          body: "# Risks\n\nSharp **knives**.",
          fields: DOCUMENT.fields as never,
        }),
      );
    });

    test("a backup restores a whole installation, passkeys and signed records included", async () => {
      await admin.ok("PATCH", "/admin/settings", {
        siteName: "Tom Sawyer Labs",
      });
      const group = await makeGroup();
      const clearanceId = await makeClearance();
      const member = await join(group.memberLink, { name: "Sam Student" });
      const signed = await member.sign(clearanceId, member.userId!, ANSWERS);
      expect(signed.body.granted).toBe(true);
      const before = await member.get(
        `/signatures/${signed.body.signatureId}/pdf`,
      );
      const pdfBefore = new Uint8Array(await before.response.arrayBuffer());

      // Only an administrator can take one.
      expect((await member.get("/admin/backup")).status).toBe(403);
      const download = await admin.get("/admin/backup");
      expect(download.response.headers.get("content-disposition")).toMatch(
        /clearance-\d{8}T\d{6}Z\.ndjson\.gz/,
      );
      const file = new Uint8Array(await download.response.arrayBuffer());
      expect([file[0], file[1]]).toEqual([0x1f, 0x8b]);

      // A running installation cannot be overwritten.
      expect((await admin.request("POST", "/setup/restore", file)).status).toBe(
        403,
      );

      await h.close();
      h = await createHarness(engine);
      const visitor = h.client();
      expect((await visitor.ok("GET", "/state")).setupNeeded).toBe(true);

      // A file cut short is refused, and leaves nothing behind.
      const cut = await visitor.request(
        "POST",
        "/setup/restore",
        file.slice(0, file.length - 40),
      );
      expect(cut.status).toBe(400);
      const junk = await visitor.request(
        "POST",
        "/setup/restore",
        new TextEncoder().encode("hello\n"),
      );
      expect(junk.status).toBe(400);
      expect((await visitor.ok("GET", "/state")).setupNeeded).toBe(true);

      const restored = await visitor.request("POST", "/setup/restore", file);
      expect(restored.status).toBe(200);
      expect(restored.body.restored).toMatchObject({
        users: 2,
        signatures: 1,
        grants: 1,
      });
      const state = await visitor.ok("GET", "/state");
      expect(state).toMatchObject({
        setupNeeded: false,
        site: { name: "Tom Sawyer Labs" },
      });
      // Sign-ins are not part of a backup; passkeys are.
      expect(state.me).toBeNull();

      const sam = h.client();
      sam.authenticator = member.authenticator;
      expect((await sam.login()).body.userId).toBe(member.userId!);
      expect(await statusOf(sam, member.userId!, clearanceId)).toMatchObject({
        state: "active",
      });
      const after = await sam.get(`/signatures/${signed.body.signatureId}/pdf`);
      expect(new Uint8Array(await after.response.arrayBuffer())).toEqual(
        pdfBefore,
      );

      const ada = h.client();
      ada.authenticator = admin.authenticator;
      expect((await ada.login()).status).toBe(200);
      const roster = await ada.ok("GET", `/groups/${group.id}`);
      expect(roster.members.map((m: any) => m.name)).toEqual(["Sam Student"]);
      // The link the mentor handed out still works after the move.
      expect(
        (await h.client().get(`/invites/${group.memberLink}`)).status,
      ).toBe(200);
      const audit = await ada.ok("GET", "/admin/audit");
      expect(audit.map((entry: any) => entry.action)).toContain(
        "backup.restore",
      );
    });
  });
}
