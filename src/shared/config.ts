import { z } from "zod";
import { settingsSchema } from "./settings.ts";

// The configuration file: how a site is set up, in a form that can be kept in
// version control beside the documents' wording. It holds the site's settings
// (the variables documents refer to among them), each document's rules, and
// the list of groups. It does not hold the wording itself (that is the `.md`
// and `.fields.json` files) or anything about people: who is in a group, its
// links, and what anyone signed are data, and belong in backups.
//
// The site address is left out on purpose: it belongs to the deployment
// (PUBLIC_BASE_URL), and the same configuration should apply to a test copy.

export const configSettingsSchema = settingsSchema.omit({ origin: true });

export const configDocumentSchema = z.object({
  /** Documents are matched by name when a configuration is applied. */
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).default(""),
  /**
   * A release is signed by the person (or their guardian); a certification is
   * signed by a mentor attesting that the person is trained. Fixed once the
   * document exists.
   */
  kind: z.enum(["release", "certification"]).default("release"),
  requiredForAll: z.boolean().default(false),
  validityDays: z.number().int().min(1).max(3650).nullable().default(null),
  minorPolicy: z.enum(["guardian", "guardian_and_minor"]).default("guardian"),
  archived: z.boolean().default(false),
  /**
   * The published wording this configuration was written against: its version
   * number and fingerprint. Applying a configuration never publishes text; a
   * difference here is reported so that someone publishes the right files.
   */
  published: z
    .object({ version: z.number().int(), fingerprint: z.string() })
    .nullable()
    .default(null),
});

export const configGroupSchema = z.object({
  /** Groups are matched by name when a configuration is applied. */
  name: z.string().trim().min(1).max(100),
  /** The organization's own identifier for it, such as a team number. */
  code: z.string().trim().max(40).nullable().default(null),
  archived: z.boolean().default(false),
});

export const configSchema = z.object({
  clearanceConfig: z.literal(1),
  settings: configSettingsSchema.partial().default({}),
  documents: z.array(configDocumentSchema).max(200).default([]),
  groups: z.array(configGroupSchema).max(2000).default([]),
});

export type SiteConfig = z.infer<typeof configSchema>;
export type ConfigDocument = z.infer<typeof configDocumentSchema>;
export type ConfigGroup = z.infer<typeof configGroupSchema>;

/** One thing applying a configuration would change, or that it cannot change. */
export type ConfigChange =
  | { kind: "setting"; key: string; from: unknown; to: unknown }
  | { kind: "document.create"; name: string }
  | {
      kind: "document.update";
      name: string;
      field: string;
      from: unknown;
      to: unknown;
    }
  /** The published wording differs from what the file expects. Never applied automatically. */
  | {
      kind: "document.text";
      name: string;
      published: string | null;
      expected: string;
    }
  /** The file says a document is of the other kind. A kind is fixed; reported, never changed. */
  | { kind: "document.kind"; name: string; have: string; wanted: string }
  /** A document that exists on the site and is not in the file. Left alone. */
  | { kind: "document.unlisted"; name: string }
  | { kind: "group.create"; name: string }
  | {
      kind: "group.update";
      name: string;
      field: string;
      from: unknown;
      to: unknown;
    }
  /** A group that exists on the site and is not in the file. Left alone, with its members. */
  | { kind: "group.unlisted"; name: string };

/** Whether applying would actually write something for this change. */
export function isApplied(change: ConfigChange): boolean {
  return ![
    "document.text",
    "document.kind",
    "document.unlisted",
    "group.unlisted",
  ].includes(change.kind);
}
