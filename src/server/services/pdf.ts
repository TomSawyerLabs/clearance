import {
  PDFDocument,
  type PDFFont,
  type PDFPage,
  rgb,
  StandardFonts,
} from "pdf-lib";
import {
  type Answers,
  answerText,
  type Block,
  type Capacity,
  type Field,
  type Inline,
  parseDocument,
  placedQuestions,
} from "../../shared/document.ts";

// Lays a signed record out as a PDF with pdf-lib, which is plain JavaScript
// and so runs on Workers as well as Bun. Only the 14 standard PDF fonts are
// used, which keeps a record to a few kilobytes but limits the printable
// characters to Windows-1252; anything else prints as "?". The stored record
// JSON, not the PDF, is the authoritative copy of names and answers.

const PAGE = { width: 612, height: 792, margin: 56 };
const BODY = 10;
const LEADING = 1.38;
const INK = rgb(0, 0, 0);
const MUTED = rgb(0.35, 0.35, 0.35);

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
  mono: PDFFont;
}

interface Word {
  text: string;
  font: PDFFont;
  width: number;
  /** A space precedes this word when it is not first on its line. */
  spaced: boolean;
  /** A forced line break follows. */
  breakAfter?: boolean;
}

class Writer {
  page: PDFPage;
  y: number;

  constructor(
    readonly doc: PDFDocument,
    readonly fonts: Fonts,
    /** The questions and answers, for those placed in the text. */
    readonly questions: { fields: Field[]; answers: Answers },
  ) {
    this.page = doc.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - PAGE.margin;
  }

  space(height: number) {
    this.y -= height;
  }

  /** Starts a new page unless `height` more points fit on this one. */
  need(height: number) {
    if (this.y - height >= PAGE.margin) return;
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - PAGE.margin;
  }

  private fontFor(inline: Inline, base: "regular" | "bold"): PDFFont {
    if (inline.code) return this.fonts.mono;
    const bold = inline.bold || base === "bold";
    if (bold && inline.italic) return this.fonts.boldItalic;
    if (bold) return this.fonts.bold;
    return inline.italic ? this.fonts.italic : this.fonts.regular;
  }

  private words(
    inlines: Inline[],
    size: number,
    base: "regular" | "bold",
  ): Word[] {
    const words: Word[] = [];
    let spaced = false;
    for (const inline of inlines) {
      const font = this.fontFor(inline, base);
      const lines = inline.text.split("\n");
      lines.forEach((line, lineIndex) => {
        for (const part of line.split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) {
            spaced = true;
            continue;
          }
          const text = printable(part, font);
          words.push({
            text,
            font,
            width: font.widthOfTextAtSize(text, size),
            spaced,
          });
          spaced = false;
        }
        if (lineIndex < lines.length - 1) {
          const last = words.at(-1);
          if (last) last.breakAfter = true;
          spaced = false;
        }
      });
    }
    return words;
  }

  /** Wrapped text. `indent` shifts the block right; `marker` hangs in the indent. */
  text(
    inlines: Inline[],
    options: {
      size?: number;
      base?: "regular" | "bold";
      indent?: number;
      marker?: string;
      color?: ReturnType<typeof rgb>;
    } = {},
  ) {
    const size = options.size ?? BODY;
    const indent = options.indent ?? 0;
    const color = options.color ?? INK;
    const left = PAGE.margin + indent;
    const maxWidth = PAGE.width - PAGE.margin - left;
    const lineHeight = size * LEADING;
    const space = (font: PDFFont) => font.widthOfTextAtSize(" ", size);

    const lines: Word[][] = [[]];
    let width = 0;
    for (const word of this.words(inlines, size, options.base ?? "regular")) {
      const line = lines.at(-1)!;
      const gap = line.length && word.spaced ? space(word.font) : 0;
      if (line.length && width + gap + word.width > maxWidth) {
        lines.push([word]);
        width = word.width;
      } else {
        line.push(word);
        width += gap + word.width;
      }
      if (word.breakAfter) {
        lines.push([]);
        width = 0;
      }
    }

    lines.forEach((line, index) => {
      this.need(lineHeight);
      this.y -= lineHeight;
      if (index === 0 && options.marker) {
        const marker = printable(options.marker, this.fonts.regular);
        this.page.drawText(marker, {
          x: left - this.fonts.regular.widthOfTextAtSize(marker, size) - 5,
          y: this.y,
          size,
          font: this.fonts.regular,
          color,
        });
      }
      // Neighbouring words in the same font are drawn as one string, spaces
      // included, so that text copied or searched in the PDF reads normally.
      let x = left;
      let run: { text: string; font: PDFFont; x: number } | null = null;
      const flush = () => {
        if (run) {
          this.page.drawText(run.text, {
            x: run.x,
            y: this.y,
            size,
            font: run.font,
            color,
          });
        }
        run = null;
      };
      line.forEach((word, wordIndex) => {
        const gap = wordIndex > 0 && word.spaced;
        if (run && run.font === word.font) {
          run.text += (gap ? " " : "") + word.text;
        } else {
          flush();
          // A space between two fonts is drawn with neither; it is just a gap.
          run = {
            text: word.text,
            font: word.font,
            x: gap ? x + space(word.font) : x,
          };
        }
        x += (gap ? space(word.font) : 0) + word.width;
      });
      flush();
    });
  }

  plain(text: string, options: Parameters<Writer["text"]>[1] = {}) {
    this.text([{ text }], options);
  }

  rule() {
    this.need(10);
    this.y -= 6;
    this.page.drawLine({
      start: { x: PAGE.margin, y: this.y },
      end: { x: PAGE.width - PAGE.margin, y: this.y },
      thickness: 0.75,
      color: MUTED,
    });
    this.y -= 4;
  }

  blocks(blocks: Block[], indent = 0) {
    for (const block of blocks) {
      switch (block.type) {
        case "heading": {
          const size = block.level <= 1 ? 15 : block.level === 2 ? 12.5 : 11;
          // Keep a heading with at least the first lines of what follows it.
          this.need(size * LEADING + BODY * LEADING * 2);
          this.space(size * 0.45);
          this.text(block.inlines, { size, base: "bold", indent });
          this.space(2);
          break;
        }
        case "paragraph":
          this.text(block.inlines, { indent });
          this.space(BODY * 0.5);
          break;
        case "list":
          block.items.forEach((item, index) => {
            const marker = block.ordered ? `${block.start + index}.` : "•";
            const [first, ...rest] = item;
            if (first?.type === "paragraph") {
              this.text(first.inlines, { indent: indent + 20, marker });
              this.space(BODY * 0.25);
              this.blocks(rest, indent + 20);
            } else {
              this.blocks(item, indent + 20);
            }
          });
          this.space(BODY * 0.25);
          break;
        case "quote":
          this.blocks(block.blocks, indent + 16);
          break;
        case "rule":
          this.rule();
          break;
        case "question": {
          const field = this.questions.fields.find(
            (candidate) => candidate.key === block.key,
          );
          if (field) this.question(field, indent);
          break;
        }
      }
    }
  }

  /** A question where the text placed it, with its answer beside it. */
  question(field: Field, indent = 0) {
    const value = this.questions.answers[field.key];
    const left = PAGE.margin + indent;
    this.space(3);
    if (field.type === "acknowledge" || field.type === "checkbox") {
      // A box, ticked or not, with the statement beside it.
      this.text([{ text: field.label }], { indent: indent + 16 });
      const top = this.y + BODY * LEADING - 1;
      this.page.drawRectangle({
        x: left + 1,
        y: top - 9,
        width: 9,
        height: 9,
        borderColor: INK,
        borderWidth: 0.75,
      });
      if (value === true) {
        this.page.drawText("X", {
          x: left + 2.5,
          y: top - 8,
          size: 8,
          font: this.fonts.bold,
          color: INK,
        });
      }
    } else if (field.type === "initials") {
      // A boxed set of initials, as on a paper form.
      const initials = printable(answerText(value), this.fonts.bold);
      this.need(22);
      this.y -= 18;
      this.page.drawRectangle({
        x: left,
        y: this.y - 4,
        width: 46,
        height: 18,
        borderColor: INK,
        borderWidth: 0.75,
      });
      this.page.drawText(initials, {
        x: left + 23 - this.fonts.bold.widthOfTextAtSize(initials, 10) / 2,
        y: this.y + 1,
        size: 10,
        font: this.fonts.bold,
        color: INK,
      });
      this.page.drawText(printable(field.label, this.fonts.regular), {
        x: left + 54,
        y: this.y + 1,
        size: 9,
        font: this.fonts.regular,
        color: MUTED,
      });
    } else {
      this.text([{ text: field.label }], { base: "bold", indent });
      this.plain(answerText(value), { indent: indent + 12 });
    }
    this.space(BODY * 0.5);
  }
}

/** Replaces characters the font cannot draw; pdf-lib throws on them otherwise. */
function printable(text: string, font: PDFFont): string {
  const supported = charsetOf(font);
  let out = "";
  for (const char of text)
    out += supported.has(char.codePointAt(0)!) ? char : "?";
  return out;
}

const charsets = new WeakMap<PDFFont, Set<number>>();
function charsetOf(font: PDFFont): Set<number> {
  let set = charsets.get(font);
  if (!set) {
    set = new Set(font.getCharacterSet());
    charsets.set(font, set);
  }
  return set;
}

export interface RecordPdfInput {
  siteName: string;
  timezone: string;
  clearanceName: string;
  title: string;
  version: number;
  body: string;
  bodyHash: string;
  fields: Field[];
  answers: Answers;
  signatureId: string;
  subjectName: string;
  subjectBirthdate: string | null;
  signerName: string;
  capacity: Capacity;
  statement: string;
  signedAt: string;
  ip: string;
  recordHash: string;
  credentialId: string;
}

export function formatInstant(iso: string, timezone: string): string {
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    dateStyle: "long",
    timeStyle: "long",
  }).format(new Date(iso));
  return timezone === "UTC" ? local : `${local} (${iso} UTC)`;
}

export function capacityPhrase(
  input: Pick<RecordPdfInput, "capacity" | "subjectName">,
): string {
  switch (input.capacity) {
    case "guardian":
      return `as parent or legal guardian of ${input.subjectName}`;
    case "minor":
      return "as the participant (a minor), alongside a parent or guardian";
    case "attester":
      return `as a mentor, certifying ${input.subjectName}`;
    default:
      return "on their own behalf";
  }
}

export async function renderRecordPdf(
  input: RecordPdfInput,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${input.title} - ${input.subjectName}`);
  doc.setSubject(`Signed record ${input.signatureId}`);
  doc.setCreator("Clearance");
  doc.setProducer("Clearance");
  // Fixed dates keep the bytes a function of the record alone.
  doc.setCreationDate(new Date(input.signedAt));
  doc.setModificationDate(new Date(input.signedAt));

  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
  const w = new Writer(doc, fonts, {
    fields: input.fields,
    answers: input.answers,
  });

  w.plain(input.siteName, { size: 9, color: MUTED });
  w.plain(input.title, { size: 17, base: "bold" });
  w.plain(`${input.clearanceName} · version ${input.version}`, {
    size: 9,
    color: MUTED,
  });
  w.rule();
  w.space(4);

  const blocks = parseDocument(input.body);
  w.blocks(blocks);

  // Questions placed in the text were printed there; the rest go here.
  const placed = new Set(placedQuestions(blocks));
  const answered = input.fields.filter(
    (field) => field.key in input.answers && !placed.has(field.key),
  );
  if (answered.length) {
    w.rule();
    w.need(60);
    w.plain("Answers", { size: 12.5, base: "bold" });
    w.space(3);
    for (const field of answered) {
      w.need(BODY * LEADING * 2);
      w.plain(field.label, { base: "bold" });
      w.plain(answerText(input.answers[field.key]), { indent: 12 });
      w.space(BODY * 0.4);
    }
  }

  w.rule();
  w.need(150);
  w.plain("Electronic signature", { size: 12.5, base: "bold" });
  w.space(3);
  w.plain(input.statement);
  w.space(6);
  w.text([
    { text: "Signed by " },
    { text: input.signerName, bold: true },
    { text: `, ${capacityPhrase(input)}.` },
  ]);
  const about = input.subjectBirthdate
    ? `${input.subjectName} (born ${input.subjectBirthdate})`
    : input.subjectName;
  w.plain(
    `${input.capacity === "attester" ? "Certified" : "Participant"}: ${about}`,
  );
  w.plain(`Signed: ${formatInstant(input.signedAt, input.timezone)}`);
  w.space(6);
  w.plain(
    "The signer approved this record with a passkey. The passkey's signature over the record " +
      "hash below is stored with the record and can be verified independently.",
    { size: 8.5, color: MUTED },
  );
  w.space(3);
  const evidence: [string, string][] = [
    ["Record", input.signatureId],
    ["Record SHA-256", input.recordHash],
    ["Document SHA-256", input.bodyHash],
    ["Passkey", input.credentialId],
    ["Network address", input.ip || "not recorded"],
  ];
  for (const [label, value] of evidence) {
    w.text([{ text: `${label}: ` }, { text: value, code: true }], {
      size: 8,
      color: MUTED,
    });
  }

  const pages = doc.getPages();
  pages.forEach((page, index) => {
    const footer = printable(
      `${input.siteName} · record ${input.signatureId} · page ${index + 1} of ${pages.length}`,
      fonts.regular,
    );
    page.drawText(footer, {
      x: PAGE.margin,
      y: 30,
      size: 7.5,
      font: fonts.regular,
      color: MUTED,
    });
  });

  return doc.save();
}
