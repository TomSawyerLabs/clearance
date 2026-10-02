import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";

/** Gives a page a software passkey authenticator that approves every prompt. */
async function withPasskeys(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return page;
}

test("an admin sets up a release and a parent signs it for their child", async ({
  browser,
}) => {
  // --- The administrator sets the site up -----------------------------------
  // The administrator's browser is in Los Angeles; the site should start there.
  const admin = await withPasskeys(
    await browser.newContext({ timezoneId: "America/Los_Angeles" }),
  );
  await admin.goto("/");
  await expect(
    admin.getByRole("heading", { name: "Set up this site" }),
  ).toBeVisible();
  await admin.getByLabel("Your name").fill("Ada Admin");
  await admin
    .getByRole("button", { name: "Create administrator account" })
    .click();
  await expect(
    admin.getByRole("heading", { name: "My clearances" }),
  ).toBeVisible();

  await admin.getByRole("link", { name: "Settings" }).click();
  await expect(admin.getByRole("heading", { name: "Settings" })).toBeVisible();
  await admin.getByLabel("Site name").fill("Tom Sawyer Labs");
  // Taken from the browser at setup, with no one having typed it.
  await expect(admin.getByRole("combobox", { name: "Time zone" })).toHaveValue(
    "America/Los_Angeles",
  );
  // The selector searches the full list of zones.
  await admin.getByRole("combobox", { name: "Time zone" }).fill("Honolulu");
  await admin.getByRole("option", { name: "Pacific/Honolulu" }).click();
  await expect(
    admin.getByText("Your browser is set to America/Los_Angeles."),
  ).toBeVisible();
  await admin.getByRole("button", { name: "Use America/Los_Angeles" }).click();
  await expect(admin.getByRole("combobox", { name: "Time zone" })).toHaveValue(
    "America/Los_Angeles",
  );
  await admin.getByLabel("People under the adult age can take part").check();
  // Guardians come with minors unless switched off.
  await expect(
    admin.getByLabel("A parent or guardian signs for them"),
  ).toBeChecked();
  await admin.getByRole("button", { name: "Save settings" }).click();
  await expect(admin.getByText("Saved.")).toBeVisible();
  await expect(
    admin.getByRole("banner").getByText("Tom Sawyer Labs"),
  ).toBeVisible();

  // --- The configuration file: downloaded, edited, previewed, applied --------
  const [configDownload] = await Promise.all([
    admin.waitForEvent("download"),
    admin.getByRole("button", { name: "Download configuration" }).click(),
  ]);
  expect(configDownload.suggestedFilename()).toBe("clearance.config.json");
  const configChunks: Buffer[] = [];
  for await (const chunk of await configDownload.createReadStream()) {
    configChunks.push(chunk as Buffer);
  }
  const siteConfig = JSON.parse(Buffer.concat(configChunks).toString());
  expect(siteConfig.settings).toMatchObject({
    siteName: "Tom Sawyer Labs",
    minorsEnabled: true,
  });
  const configInput = admin.locator('input[type="file"]');
  await configInput.setInputFiles({
    name: "clearance.config.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(siteConfig)),
  });
  await expect(
    admin.getByText("Nothing to change: this site already matches the file."),
  ).toBeVisible();
  await admin.getByRole("button", { name: "Close" }).click();
  await configInput.setInputFiles({
    name: "clearance.config.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        ...siteConfig,
        settings: { ...siteConfig.settings, sessionDays: 14 },
        groups: [{ name: "Gear Heads", code: "200" }],
      }),
    ),
  });
  await expect(admin.getByText("New group “Gear Heads”")).toBeVisible();
  await expect(admin.getByText("30 becomes 14")).toBeVisible();
  await admin.getByRole("button", { name: "Apply 2 changes" }).click();
  await expect(admin.getByText("Applied 2 changes.")).toBeVisible();
  // The form above picks the applied value up.
  await expect(
    admin.getByLabel("Days before someone has to sign in again"),
  ).toHaveValue("14");

  // --- A document --------------------------------------------------------------
  // Wait for each page by its heading before typing: a label like "Name"
  // also matches "Site name" on the page being left.
  await admin.getByRole("link", { name: "Documents" }).click();
  await expect(
    admin.getByRole("heading", { name: "New document" }),
  ).toBeVisible();
  await admin.getByLabel(/^Name/).fill("General release");
  await admin
    .getByRole("button", { name: "Create, then write the text" })
    .click();
  await expect(
    admin.getByRole("heading", { name: "Write the text" }),
  ).toBeVisible();
  await admin.getByLabel(/^Title/).fill("Shop release");
  await admin
    .getByLabel("Document text")
    .fill(
      "# Risks\n\nThe shop has **sharp tools**.\n\n1. Wear safety glasses.\n2. Ask when unsure.\n",
    );
  await admin.getByRole("button", { name: "Add a question" }).click();
  await admin
    .getByLabel("Question or statement")
    .fill("Emergency contact name and phone");
  await admin.getByLabel("Must be answered").check();
  // The same questions round-trip through the JSON form, with a key derived
  // from the label.
  await admin.getByRole("button", { name: "Paste questions as JSON" }).click();
  await expect(admin.getByLabel("Questions as JSON")).toHaveValue(
    /"key": "emergency_contact_name_and_phone"/,
  );
  await admin.getByRole("button", { name: "Use these questions" }).click();
  await expect(admin.getByLabel("Question or statement")).toHaveValue(
    "Emergency contact name and phone",
  );
  await admin
    .getByRole("button", { name: "Preview" })
    .or(admin.getByText("Preview", { exact: true }))
    .first()
    .click();
  await expect(admin.getByText("sharp tools")).toBeVisible();
  await admin.getByRole("button", { name: "Publish version 1" }).click();
  await expect(
    admin.getByText("published", { exact: false }).first(),
  ).toBeVisible();
  await expect(
    admin.getByRole("heading", { name: "Edit the text" }),
  ).toBeVisible();

  // --- The same document kept as files: loaded, published, downloaded --------
  const markdown =
    "# Shop release\r\n\r\n## Risks\r\n\r\nThe shop has **hot irons**.\r\n";
  const questions = [
    {
      key: "contact",
      label: "Emergency contact name and phone",
      type: "text",
      required: true,
    },
  ];
  await admin.locator('input[type="file"]').setInputFiles([
    {
      name: "release.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(markdown),
    },
    {
      name: "release.fields.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(questions)),
    },
  ]);
  await expect(admin.getByLabel("Document text")).toHaveValue(
    "## Risks\n\nThe shop has **hot irons**.",
  );
  await expect(admin.getByLabel(/^Title/)).toHaveValue("Shop release");
  // The fingerprint, worked out here by hand: SHA-256 of the canonical JSON
  // (keys sorted, no spaces) of the title, the text with LF endings, and the
  // questions. The page recomputes its own as each file is applied, so wait
  // for it to arrive at this value instead of reading it once.
  const draft = createHash("sha256")
    .update(
      `{"body":${JSON.stringify("## Risks\n\nThe shop has **hot irons**.")},` +
        `"fields":[{"key":"contact","label":"Emergency contact name and phone","required":true,"type":"text"}],` +
        `"title":"Shop release"}`,
    )
    .digest("hex");
  await expect(
    admin.getByText("Fingerprint of this draft").locator("code"),
  ).toHaveText(draft);
  await admin.getByRole("button", { name: "Publish version 2" }).click();
  const second = admin
    .locator("div")
    .filter({ hasText: /^Version 2, published/ })
    .first();
  await expect(second).toBeVisible();
  // What was published has the fingerprint the draft showed.
  await expect(admin.getByText(draft)).toBeVisible();
  const [file] = await Promise.all([
    admin.waitForEvent("download"),
    admin
      .getByRole("button", { name: "Download the text (.md)" })
      .first()
      .click(),
  ]);
  expect(file.suggestedFilename()).toBe("general-release.md");
  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  // The round trip gives back the file, with line endings normalised.
  expect(Buffer.concat(chunks).toString()).toBe(
    markdown.replaceAll("\r\n", "\n"),
  );

  await admin.getByLabel("Required of everyone in a group").check();
  await admin.getByRole("button", { name: "Save rules" }).click();

  // --- A team and its link ---------------------------------------------------
  await admin.getByRole("link", { name: "Groups" }).click();
  await expect(admin.getByRole("heading", { name: "New group" })).toBeVisible();
  await admin.getByLabel(/^Name/).fill("Robo Rafters");
  await admin.getByLabel("Number or code").fill("100");
  await admin.getByRole("button", { name: "Create group" }).click();
  await expect(
    admin.getByRole("heading", { name: "Robo Rafters" }),
  ).toBeVisible();
  await admin.getByRole("button", { name: "New member link" }).click();
  const link = await admin.getByLabel("Link").first().inputValue();
  expect(link).toContain("/join/");

  // --- A parent, on their own device --------------------------------------------
  const parent = await withPasskeys(await browser.newContext());
  await parent.goto(link);
  await expect(
    parent.getByText("has invited you to Robo Rafters (100)"),
  ).toBeVisible();
  await parent
    .getByLabel("I am a parent or guardian enrolling my child")
    .check();
  await parent.getByLabel("Your full name").fill("Pat Parent");
  await parent.getByRole("button", { name: "Create my account" }).click();

  await parent.getByLabel("Child's full name").fill("Kit Kid");
  await parent.getByLabel("Child's date of birth").fill("2012-05-04");
  await parent.getByRole("button", { name: "Add my child" }).click();

  await expect(parent.getByRole("heading", { name: "Kit Kid" })).toBeVisible();
  await expect(
    parent.getByText("Needs a parent or guardian to sign."),
  ).toBeVisible();
  // The parent is not in the team, so the release is optional for them; the
  // child's is the required one.
  await expect(parent.getByText("Optional.", { exact: true })).toBeVisible();
  await parent.getByRole("link", { name: "Read and sign" }).last().click();

  await expect(
    parent.getByRole("heading", { name: "Shop release" }),
  ).toBeVisible();
  await expect(
    parent.getByText("parent or legal guardian of Kit Kid"),
  ).toBeVisible();
  await parent
    .getByLabel("Emergency contact name and phone")
    .fill("Pat 555-0100");
  await parent.getByLabel(/I have read this document in full/).check();
  await parent.getByRole("button", { name: "Sign with my passkey" }).click();

  await expect(parent.getByText("That is everything.")).toBeVisible();
  await expect(parent.getByText("Pat 555-0100")).toBeVisible();
  const pdfHref = await parent
    .getByRole("link", { name: "Open the signed PDF" })
    .getAttribute("href");
  const pdf = await parent.request.get(pdfHref!);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");

  // --- The manager's view ----------------------------------------------------
  await admin.reload();
  const row = admin.getByRole("row", { name: /Kit Kid/ });
  await expect(row.getByText("Current")).toBeVisible();
  await expect(row.getByText("Guardian: Pat Parent")).toBeVisible();

  // --- Backups: downloaded here, restored into an empty second installation ---
  await admin.getByRole("link", { name: "Backups" }).click();
  await expect(
    admin.getByRole("heading", { name: "Backups", exact: true }),
  ).toBeVisible();
  // Let the page finish loading, so that nothing below races its requests.
  await expect(
    admin.getByRole("heading", { name: "Automatic backups" }),
  ).toBeVisible();
  const backup = await admin.request.get("/api/admin/backup");
  expect(backup.headers()["content-type"]).toBe("application/gzip");

  const port = 8101;
  const other = spawn(
    process.env.E2E_COMMAND || "bun",
    process.env.E2E_COMMAND ? [] : ["src/entry/bun.ts"],
    {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        DATABASE_URL: "sqlite::memory:",
      },
      stdio: "ignore",
    },
  );
  try {
    const fresh = await (await browser.newContext()).newPage();
    await expect(async () => {
      await fresh.goto(`http://localhost:${port}/`);
      await expect(
        fresh.getByRole("heading", { name: "Set up this site" }),
      ).toBeVisible();
    }).toPass({ timeout: 20_000 });
    await fresh.locator('input[type="file"]').setInputFiles({
      name: "clearance-backup.ndjson.gz",
      mimeType: "application/gzip",
      buffer: await backup.body(),
    });
    // It is the same installation, but reached at a different address, and
    // the page says so instead of leaving people with passkeys that fail.
    await expect(
      fresh.getByText("Restored, but this is a different address"),
    ).toBeVisible();
    const state = await (
      await fresh.request.get(`http://localhost:${port}/api/state`)
    ).json();
    expect(state).toMatchObject({
      setupNeeded: false,
      site: { name: "Tom Sawyer Labs" },
    });
  } finally {
    other.kill();
  }

  // Signing out and back in works with the stored passkey.
  await parent.getByRole("link", { name: "Account" }).click();
  await parent.getByRole("button", { name: "Sign out" }).click();
  await parent.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(
    parent.getByRole("heading", { name: "My clearances" }),
  ).toBeVisible();
});
