import { z } from "zod";

// Every setting is stored in the database and editable at runtime by an
// administrator. Nothing here is read from the environment.

export const settingsSchema = z.object({
  /** Shown in the UI, on signed records, and as the passkey relying-party name. */
  siteName: z.string().trim().min(1).max(100),
  /**
   * The public origin, e.g. `https://release.example.org`. Recorded from the
   * browser when the first administrator registers. Passkeys are bound to its
   * hostname, so changing the hostname invalidates every existing passkey.
   */
  origin: z.url().nullable(),
  /** IANA zone used when printing times on signed records. Storage is always UTC. */
  timezone: z.string().refine(isTimeZone, "Not a recognised IANA time zone"),
  /** Opt-in: minors need a parent or guardian account to sign for them. */
  guardiansEnabled: z.boolean(),
  /** People younger than this are minors when guardian support is on. */
  adultAge: z.number().int().min(13).max(25),
  /**
   * Which request header carries the visitor's address. Null means use what
   * the runtime reports (the socket peer on Bun, Cloudflare's own value on
   * Workers). Set it to the header your reverse proxy fills in. The address is
   * printed on signed records, so a header a visitor can forge is worse than
   * none.
   */
  clientIpHeader: z
    .enum(["x-forwarded-for", "x-real-ip", "cf-connecting-ip"])
    .nullable(),
  /** How long a sign-in lasts. */
  sessionDays: z.number().int().min(1).max(365),
  /**
   * Hours between automatic backups written to the server's disk; 0 turns
   * them off. Ignored on Cloudflare Workers, which has no disk.
   */
  backupEveryHours: z.number().int().min(0).max(720),
  /** How many automatic backups to keep before the oldest is deleted. */
  backupKeep: z.number().int().min(1).max(365),
});

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  siteName: "Clearance",
  origin: null,
  timezone: "UTC",
  guardiansEnabled: false,
  adultAge: 18,
  clientIpHeader: null,
  sessionDays: 30,
  backupEveryHours: 24,
  backupKeep: 30,
};

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
