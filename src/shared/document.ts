import { marked, type Token, type Tokens } from "marked";
import { z } from "zod";

// A document is written in Markdown and parsed into this small block model.
// The browser renders the blocks as React elements and the server lays the
// same blocks out as a PDF, so the signed copy and the on-screen copy cannot
// drift apart. Raw HTML in a document is dropped: there is no way to print it
// faithfully on every deployment target.
//
// Two kinds of marker are understood in the text:
//
//   {{legal_entity}}        a variable, replaced with a value from the site's
//                           settings when a version is published
//   {{question:initials}}   on a line of its own: the question with that key
//                           is asked here, in the text, instead of at the end

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
  | { type: "rule" }
  /** A question placed in the text with `{{question:key}}`. */
  | { type: "question"; key: string };

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

const QUESTION_LINE = /^\{\{\s*question:([a-z][a-z0-9_]*)\s*\}\}$/;

/** The question key when a paragraph is nothing but a `{{question:key}}` marker. */
function questionOf(inlines: Inline[]): string | null {
  const text = inlines.map((inline) => inline.text).join("");
  return QUESTION_LINE.exec(text.trim())?.[1] ?? null;
}

function paragraph(inlines: Inline[]): Block {
  const key = questionOf(inlines);
  return key ? { type: "question", key } : { type: "paragraph", inlines };
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
        out.push(paragraph(inlinesOf((token as Tokens.Paragraph).tokens)));
        break;
      case "text": {
        // A "tight" list item holds bare text tokens instead of paragraphs.
        const text = token as Tokens.Text;
        out.push(
          paragraph(
            text.tokens
              ? inlinesOf(text.tokens)
              : [{ text: decode(text.text) }],
          ),
        );
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

/** The keys of the questions placed in the text, in the order they appear. */
export function placedQuestions(blocks: Block[]): string[] {
  const keys: string[] = [];
  const walk = (list: Block[]) => {
    for (const block of list) {
      if (block.type === "question") keys.push(block.key);
      else if (block.type === "list") block.items.forEach(walk);
      else if (block.type === "quote") walk(block.blocks);
    }
  };
  walk(blocks);
  return keys;
}

// ---------------------------------------------------------------------------
// Variables: facts about the organization that belong in its configuration,
// not in the wording of every document.

export const KEY = /^[a-z][a-z0-9_]*$/;

export const variablesSchema = z
  .record(
    z.string().regex(KEY, "Use lowercase letters, digits and underscores"),
    z.string().trim().max(500),
  )
  .refine((variables) => Object.keys(variables).length <= 50, {
    message: "At most 50 variables",
  });

export type Variables = z.infer<typeof variablesSchema>;

const MARKER = /\{\{\s*([a-z][a-z0-9_]*(?::[a-z][a-z0-9_]*)?)\s*\}\}/g;

/**
 * Replaces `{{name}}` with the variable's value. Question markers are left
 * as they are. Names with no value are reported, each once, in order.
 */
export function resolveVariables(
  text: string,
  variables: Variables,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const resolved = text.replace(MARKER, (whole, name: string) => {
    if (name.startsWith("question:")) return whole;
    if (name in variables) return variables[name]!;
    if (!missing.includes(name)) missing.push(name);
    return whole;
  });
  return { text: resolved, missing };
}

/** Every `{{name}}` in the text, each once, question markers excluded. */
export function variablesUsed(text: string): string[] {
  return resolveVariables(text, {}).missing;
}

/** Every `{{question:key}}` in the text, wherever it is, each occurrence. */
export function questionMarkers(text: string): string[] {
  return Array.from(text.matchAll(MARKER), (match) => match[1]!)
    .filter((name) => name.startsWith("question:"))
    .map((name) => name.slice("question:".length));
}

// ---------------------------------------------------------------------------
// Questions the signer answers as part of signing.

export const FIELD_TYPES = [
  "text",
  "longtext",
  "choice",
  "multichoice",
  "checkbox",
  "acknowledge",
  "initials",
  "date",
  "name",
] as const;

export const fieldSchema = z.object({
  key: z
    .string()
    .regex(KEY, "Use lowercase letters, digits and underscores")
    .max(40),
  label: z.string().trim().min(1).max(300),
  /**
   * `acknowledge` is a box that must be ticked to sign; `checkbox` is an
   * optional yes/no; `choice` picks one of `options` and `multichoice` any
   * number of them; `initials` is the signer's initials, always required;
   * `date` is a calendar date; `name` is the signer typing their own name,
   * which must match the name on their account.
   */
  type: z.enum(FIELD_TYPES),
  options: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  required: z.boolean().optional(),
  help: z.string().trim().max(500).optional(),
  /**
   * Who answers. `primary` is the adult signing (the person themself, their
   * guardian, or the mentor certifying them). `minor` is a minor co-signing
   * their own release.
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
      if (
        (field.type === "choice" || field.type === "multichoice") &&
        !field.options?.length
      ) {
        ctx.addIssue({
          code: "custom",
          path: [index, "options"],
          message: "A choice needs at least one option",
        });
      }
    });
  });

/**
 * Checks that every `{{question:key}}` in the text names a question and
 * stands on a line of its own. Returns the problems, in words.
 */
export function checkMarkers(body: string, fields: Field[]): string[] {
  const problems: string[] = [];
  const keys = new Set(fields.map((field) => field.key));
  const markers = questionMarkers(body);
  for (const key of new Set(markers)) {
    if (!keys.has(key))
      problems.push(`There is no question with key "${key}".`);
  }
  const placed = placedQuestions(parseDocument(body));
  if (placed.length !== markers.length) {
    problems.push(
      "A {{question:...}} marker must be on a line of its own, with a blank line before and after.",
    );
  }
  const repeated = placed.find((key, index) => placed.indexOf(key) !== index);
  if (repeated) problems.push(`The question "${repeated}" is placed twice.`);
  return problems;
}

export type Answer = string | boolean | string[];
export type Answers = Record<string, Answer>;

/**
 * In what role someone signs: for themself, as a minor's guardian, as a
 * minor beside their guardian, or as the mentor attesting a certification.
 */
export type Capacity = "self" | "guardian" | "minor" | "attester";

export function fieldsFor(fields: Field[], capacity: Capacity): Field[] {
  const audience = capacity === "minor" ? "minor" : "primary";
  return fields.filter((field) => (field.audience ?? "primary") === audience);
}

/** Whether a question has to be answered: some kinds always do. */
export function isRequired(field: Field): boolean {
  return (
    field.type === "acknowledge" ||
    field.type === "initials" ||
    field.type === "name" ||
    field.required === true
  );
}

/** `Pat  O'Brien ` and `pat o'brien` are the same name. */
function sameName(a: string, b: string): boolean {
  const fold = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");
  return fold(a) === fold(b);
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/**
 * Checks answers against the fields a signer in `capacity` must fill in and
 * returns them normalised, or a list of problems keyed by field.
 */
export function checkAnswers(
  fields: Field[],
  capacity: Capacity,
  raw: Record<string, unknown>,
  signer: { name: string } = { name: "" },
):
  | { ok: true; answers: Answers }
  | { ok: false; problems: Record<string, string> } {
  const answers: Answers = {};
  const problems: Record<string, string> = {};
  for (const field of fieldsFor(fields, capacity)) {
    const value = raw[field.key];
    const text = typeof value === "string" ? value.trim() : "";
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
      case "multichoice": {
        const chosen = Array.isArray(value)
          ? value.filter(
              (option, index): option is string =>
                typeof option === "string" &&
                field.options!.includes(option) &&
                value.indexOf(option) === index,
            )
          : [];
        if (Array.isArray(value) && chosen.length !== value.length)
          problems[field.key] = "Choose from the options.";
        else if (field.required && chosen.length === 0)
          problems[field.key] = "Choose at least one option.";
        else answers[field.key] = chosen;
        break;
      }
      case "initials": {
        const initials = text.toUpperCase();
        if (!/^\p{L}{1,5}$/u.test(initials))
          problems[field.key] = "Type your initials, letters only.";
        else answers[field.key] = initials;
        break;
      }
      case "date":
        if (text && !isDate(text))
          problems[field.key] = "Enter a date as YYYY-MM-DD.";
        else if (!text && field.required)
          problems[field.key] = "This is required.";
        else answers[field.key] = text;
        break;
      case "name":
        if (!text) problems[field.key] = "Type your name.";
        else if (signer.name && !sameName(text, signer.name))
          problems[field.key] =
            `Type your name as it is on your account: ${signer.name}.`;
        else answers[field.key] = text;
        break;
      default:
        if (text.length > 2000)
          problems[field.key] = "This answer is too long.";
        else if (!text && field.required)
          problems[field.key] = "This is required.";
        else answers[field.key] = text;
    }
  }
  return Object.keys(problems).length
    ? { ok: false, problems }
    : { ok: true, answers };
}

/** An answer as words, for the signed record. */
export function answerText(value: Answer | undefined): string {
  if (value === undefined) return "(not answered)";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.join("; ") : "(none)";
  return value || "(left blank)";
}
