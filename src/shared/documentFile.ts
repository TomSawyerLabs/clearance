import {
  type Field,
  fieldsSchema,
  resolveVariables,
  type Variables,
} from "./document.ts";

// A document as files, so that its wording can be written, reviewed and kept
// in version control, and a published version matched back to a commit.
//
//   <name>.md            "# Title" on the first line, then the text
//   <name>.fields.json   the questions (optional)
//
// The fingerprint below is what ties the two worlds together. It is computed
// the same way by the server when publishing, by the editor for a draft, and
// by `clearance hash` for files on disk.

/**
 * JSON with object keys sorted at every level and no whitespace, so that the
 * same value always serialises, and therefore hashes, the same.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * Line endings and surrounding blank space are not part of the wording. A
 * file checked out with CRLF on Windows must fingerprint the same as the LF
 * copy on a server.
 */
export function normalizeText(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

export interface DocumentContent {
  title: string;
  body: string;
  fields: Field[];
}

export function normalizeDocument(content: DocumentContent): DocumentContent {
  return {
    title: normalizeText(content.title),
    body: normalizeText(content.body),
    // Parsing drops unknown keys, so stray properties cannot change the fingerprint.
    fields: fieldsSchema.parse(content.fields),
  };
}

/**
 * The document with every `{{variable}}` replaced, in the title, the text and
 * the questions' wording. This is what gets published and fingerprinted: the
 * words people sign, not a template. Names with no value are reported.
 */
export function resolveDocument(
  content: DocumentContent,
  variables: Variables,
): { content: DocumentContent; missing: string[] } {
  const missing = new Set<string>();
  const resolve = (text: string) => {
    const result = resolveVariables(text, variables);
    result.missing.forEach((name) => missing.add(name));
    return result.text;
  };
  return {
    content: {
      title: resolve(content.title),
      body: resolve(content.body),
      fields: content.fields.map((field) => ({
        ...field,
        label: resolve(field.label),
        ...(field.help !== undefined && { help: resolve(field.help) }),
        ...(field.options && { options: field.options.map(resolve) }),
      })),
    },
    missing: [...missing],
  };
}

/** SHA-256, in hex, of the canonical JSON of the normalised title, text and questions. */
export async function documentFingerprint(
  content: DocumentContent,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    canonicalJson(normalizeDocument(content)),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Splits a Markdown file into its title (a leading `# Heading`) and the rest. */
export function fromMarkdownFile(text: string): {
  title: string | null;
  body: string;
} {
  const normalized = normalizeText(text);
  const match = /^# +(.+?) *#* *(?:\n|$)/.exec(normalized);
  if (!match) return { title: null, body: normalized };
  return {
    title: match[1]!.trim(),
    body: normalized.slice(match[0].length).trim(),
  };
}

export function toMarkdownFile(title: string, body: string): string {
  return `# ${normalizeText(title)}\n\n${normalizeText(body)}\n`;
}

export function toFieldsFile(fields: Field[]): string {
  return `${JSON.stringify(fields, null, 2)}\n`;
}
