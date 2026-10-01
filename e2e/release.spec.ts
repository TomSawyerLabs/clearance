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
  const admin = await withPasskeys(await browser.newContext());
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
  await admin.getByLabel("Time zone").fill("America/Los_Angeles");
  await admin
    .getByLabel("People under age need a parent or guardian to sign")
    .check();
  await admin.getByRole("button", { name: "Save settings" }).click();
  await expect(admin.getByText("Saved.")).toBeVisible();
  await expect(
    admin.getByRole("banner").getByText("Tom Sawyer Labs"),
  ).toBeVisible();

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
  await expect(admin.getByText("Version 1, published")).toBeVisible();
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

  // Signing out and back in works with the stored passkey.
  await parent.getByRole("link", { name: "Account" }).click();
  await parent.getByRole("button", { name: "Sign out" }).click();
  await parent.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(
    parent.getByRole("heading", { name: "My clearances" }),
  ).toBeVisible();
});
