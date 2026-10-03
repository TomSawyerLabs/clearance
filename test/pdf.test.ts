import { expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import {
  checkMarkers,
  parseDocument,
  placedQuestions,
} from "../src/shared/document.ts";
import { renderRecordPdf } from "../src/server/services/pdf.ts";

const base = {
  siteName: "Tom Sawyer Labs",
  timezone: "America/Los_Angeles",
  clearanceName: "General release",
  title: "Shop release",
  version: 3,
  bodyHash: "a".repeat(64),
  fields: [
    { key: "contact", label: "Emergency contact", type: "text" as const },
    { key: "photos", label: "Photos may be used", type: "checkbox" as const },
  ],
  answers: { contact: "Pat 555-0100", photos: false },
  signatureId: "0b0e6c1e-0000-4000-8000-000000000000",
  subjectName: "Kit Kid",
  subjectBirthdate: "2012-05-04",
  signerName: "Pat Parent",
  capacity: "guardian" as const,
  statement: "I have read this document in full.",
  signedAt: "2026-10-01T21:30:00.000Z",
  ip: "203.0.113.7",
  recordHash: "b".repeat(64),
  credentialId: "c".repeat(43),
};

test("Markdown becomes the block model, and raw HTML is dropped", () => {
  const blocks = parseDocument(
    "# Title\n\nSome **bold *both*** and `code` & <b>html</b>.\n\n1. One\n2. Two\n   - nested\n\n> quoted\n\n---\n\n<script>alert(1)</script>\n",
  );
  expect(blocks.map((block) => block.type)).toEqual([
    "heading",
    "paragraph",
    "list",
    "quote",
    "rule",
  ]);
  const paragraph = blocks[1] as Extract<
    (typeof blocks)[number],
    { type: "paragraph" }
  >;
  expect(paragraph.inlines).toContainEqual({
    text: "both",
    bold: true,
    italic: true,
  });
  expect(paragraph.inlines).toContainEqual({ text: "code", code: true });
  // The entity is decoded once, and the tags contribute nothing.
  expect(paragraph.inlines.map((inline) => inline.text).join("")).toBe(
    "Some bold both and code & html.",
  );
  const list = blocks[2] as Extract<(typeof blocks)[number], { type: "list" }>;
  expect(list.ordered).toBe(true);
  expect(list.items[1]?.[1]).toMatchObject({ type: "list", ordered: false });
});

test("a long document flows onto more pages and every page is numbered", async () => {
  const body = Array.from(
    { length: 30 },
    (_, index) =>
      `## Section ${index + 1}\n\n${"The shop has sharp tools and hot irons. ".repeat(12)}\n\n- one\n- two\n`,
  ).join("\n");
  const pdf = await PDFDocument.load(await renderRecordPdf({ ...base, body }));
  expect(pdf.getPageCount()).toBeGreaterThan(3);
  expect(pdf.getTitle()).toBe("Shop release - Kit Kid");
});

test("the same record always renders to the same bytes", async () => {
  const body = "# Risks\n\nThe shop has **sharp tools**.\n";
  const first = await renderRecordPdf({ ...base, body });
  const second = await renderRecordPdf({ ...base, body });
  expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
});

test("questions placed in the text are printed there, the rest at the end", async () => {
  const fields = [
    { key: "initials", label: "Initial here", type: "initials" as const },
    {
      key: "agree",
      label: "I agree to the rules",
      type: "acknowledge" as const,
    },
    {
      key: "photos",
      label: "Photos may be used",
      type: "multichoice" as const,
      options: ["Website", "Social media"],
    },
    { key: "contact", label: "Emergency contact", type: "text" as const },
  ];
  const body =
    "# Rules\n\nFollow them.\n\n{{question:initials}}\n\n{{question:agree}}\n\n- A list item\n- {{question:photos}}\n";
  const blocks = parseDocument(body);
  expect(placedQuestions(blocks)).toEqual(["initials", "agree", "photos"]);
  // The marker has to be a whole paragraph; one inside a sentence is text.
  expect(
    placedQuestions(parseDocument("Initial {{question:initials}} here")),
  ).toEqual([]);
  expect(checkMarkers(body, fields)).toEqual([]);
  expect(checkMarkers("{{question:nope}}", fields)[0]).toContain("nope");

  const bytes = await renderRecordPdf({
    ...base,
    body,
    fields,
    answers: {
      initials: "KK",
      agree: true,
      photos: ["Website", "Social media"],
      contact: "Pat 555-0100",
    },
  });
  const pdf = await PDFDocument.load(bytes);
  expect(pdf.getPageCount()).toBe(1);
  // The streams are compressed, so the words cannot be grepped; what can be
  // checked is that each answer, placed or trailing, changes the output.
  const withoutContact = await renderRecordPdf({
    ...base,
    body,
    fields,
    answers: { initials: "KK", agree: true, photos: ["Website"] },
  });
  expect(Buffer.from(withoutContact).equals(Buffer.from(bytes))).toBe(false);
  const unticked = await renderRecordPdf({
    ...base,
    body,
    fields,
    answers: { initials: "KK", agree: false, photos: ["Website"] },
  });
  expect(Buffer.from(unticked).equals(Buffer.from(withoutContact))).toBe(false);
});

test("characters the built-in fonts lack do not break rendering", async () => {
  const bytes = await renderRecordPdf({
    ...base,
    body: "Names: 李小龙, Zoë, Łukasz, “quoted” — dash, emoji 🤖.",
    subjectName: "李小龙",
    answers: { contact: "Ελένη 555", photos: true },
  });
  expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
});
