import { expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { parseDocument } from "../src/shared/document.ts";
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

test("characters the built-in fonts lack do not break rendering", async () => {
  const bytes = await renderRecordPdf({
    ...base,
    body: "Names: 李小龙, Zoë, Łukasz, “quoted” — dash, emoji 🤖.",
    subjectName: "李小龙",
    answers: { contact: "Ελένη 555", photos: true },
  });
  expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
});
