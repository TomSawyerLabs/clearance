import { marked, type Token, type Tokens } from "marked";
import { z } from "zod";

// A document is written in Markdown and parsed into this small block model.
// The browser renders the blocks as React elements and the server lays the
// same blocks out as a PDF, so the signed copy and the on-screen copy cannot
// drift apart. Raw HTML in a document is dropped: there is no way to print it
// faithfully on every deployment target.

export interface Inline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
}

export type Block =
  | { type: "heading"; level: number; inlines: Inline[] }
  | { type: "paragraph"; inlines: Inline[] }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] }
  | { type: "quote"; blocks: Block[] }
  | { type: "rule" };

type Style = Omit<Inline, "text">;

function inlinesOf(tokens: Token[] | undefined, style: Style = {}): Inline[] {
  const out: Inline[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "strong":
        out.push(
          ...inlinesOf((token as Tokens.Strong).tokens, {
            ...style,
            bold: true,
          }),
        );
        break;
      case "em":
        out.push(
          ...inlinesOf((token as Tokens.Em).tokens, { ...style, italic: true }),
        );
        break;
      case "codespan":
        out.push({
          ...style,
          code: true,
          text: decode((token as Tokens.Codespan).text),
        });
        break;
      case "link": {
        const link = token as Tokens.Link;
        const href = /^(https?:|mailto:)/i.test(link.href)
          ? link.href
          : undefined;
        out.push(...inlinesOf(link.tokens, { ...style, href }));
        break;
      }
      case "br":
        out.push({ ...style, text: "\n" });
        break;
      case "html":
      case "image":
        break;
      default: {
        const nested = (token as Tokens.Text).tokens;
        if (nested?.length) out.push(...inlinesOf(nested, style));
        else if ("text" in token)
          out.push({ ...style, text: decode(String(token.text)) });
      }
    }
  }
  return out;
}

// marked escapes these five characters inside text tokens.
function decode(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function blocksOf(tokens: Token[]): Block[] {
  const out: Block[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const heading = token as Tokens.Heading;
        out.push({
          type: "heading",
          level: heading.depth,
          inlines: inlinesOf(heading.tokens),
        });
        break;
      }
      case "paragraph":
        out.push({
          type: "paragraph",
          inlines: inlinesOf((token as Tokens.Paragraph).tokens),
        });
        break;
      case "text": {
        // A "tight" list item holds bare text tokens instead of paragraphs.
        const text = token as Tokens.Text;
        out.push({
          type: "paragraph",
          inlines: text.tokens
            ? inlinesOf(text.tokens)
            : [{ text: decode(text.text) }],
        });
        break;
      }
      case "list": {
        const list = token as Tokens.List;
        out.push({
          type: "list",
          ordered: list.ordered,
          start: typeof list.start === "number" ? list.start : 1,
          items: list.items.map((item) => blocksOf(item.tokens)),
        });
        break;
      }
      case "blockquote":
        out.push({
          type: "quote",
          blocks: blocksOf((token as Tokens.Blockquote).tokens),
        });
        break;
      case "hr":
        out.push({ type: "rule" });
        break;
      case "code":
        out.push({
          type: "paragraph",
          inlines: [{ text: (token as Tokens.Code).text, code: true }],
        });
        break;
      default:
        break;
    }
  }
  return out;
}

export function parseDocument(markdown: string): Block[] {
  return blocksOf(marked.lexer(markdown));
}

// ---------------------------------------------------------------------------
// Questions the signer answers as part of signing.

export const fieldSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, "Use lowercase letters, digits and underscores")
    .max(40),
  label: z.string().trim().min(1).max(300),
  /**
   * `acknowledge` is a box that must be ticked to sign; `checkbox` is an
   * optional yes/no; `choice` picks one of `options`.
   */
  type: z.enum(["text", "longtext", "choice", "checkbox", "acknowledge"]),
  options: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  required: z.boolean().optional(),
  help: z.string().trim().max(500).optional(),
  /**
   * Who answers. `primary` is the adult signing (the person themself, or their
   * guardian). `minor` is a minor co-signing their own release.
   */
  audience: z.enum(["primary", "minor"]).optional(),
});

export type Field = z.infer<typeof fieldSchema>;

export const fieldsSchema = z
  .array(fieldSchema)
  .max(50)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    fields.forEach((field, index) => {
      if (seen.has(field.key)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "key"],
          message: "Duplicate key",
        });
      }
      seen.add(field.key);
      if (field.type === "choice" && !field.options?.length) {
        ctx.addIssue({
          code: "custom",
          path: [index, "options"],
          message: "A choice needs at least one option",
        });
      }
    });
  });

export type Answers = Record<string, string | boolean>;

export type Capacity = "self" | "guardian" | "minor";

export function fieldsFor(fields: Field[], capacity: Capacity): Field[] {
  const audience = capacity === "minor" ? "minor" : "primary";
  return fields.filter((field) => (field.audience ?? "primary") === audience);
}

/**
 * Checks answers against the fields a signer in `capacity` must fill in and
 * returns them normalised, or a list of problems keyed by field.
 */
export function checkAnswers(
  fields: Field[],
  capacity: Capacity,
  raw: Record<string, unknown>,
):
  | { ok: true; answers: Answers }
  | { ok: false; problems: Record<string, string> } {
  const answers: Answers = {};
  const problems: Record<string, string> = {};
  for (const field of fieldsFor(fields, capacity)) {
    const value = raw[field.key];
    switch (field.type) {
      case "acknowledge":
        if (value !== true)
          problems[field.key] = "This must be acknowledged to sign.";
        else answers[field.key] = true;
        break;
      case "checkbox":
        answers[field.key] = value === true;
        break;
      case "choice":
        if (typeof value === "string" && field.options?.includes(value))
          answers[field.key] = value;
        else if (field.required || value)
          problems[field.key] = "Choose one of the options.";
        break;
      default: {
        const text = typeof value === "string" ? value.trim() : "";
        if (text.length > 2000)
          problems[field.key] = "This answer is too long.";
        else if (!text && field.required)
          problems[field.key] = "This is required.";
        else answers[field.key] = text;
      }
    }
  }
  return Object.keys(problems).length
    ? { ok: false, problems }
    : { ok: true, answers };
}
