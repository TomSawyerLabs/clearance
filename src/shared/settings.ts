import { z } from "zod";

// Every setting here is stored in the database and editable at runtime by an
// administrator. What describes the deployment instead of the site (the
// database, the listener, the proxy in front) comes from the environment.

export const settingsSchema = z.object({
  /** Shown in the UI, on signed records, and as the passkey relying-party name. */
  siteName: z.string().trim().min(1).max(100),
  /**
   * The public origin, e.g. `https://release.example.org`. Recorded from the
   * browser when the first administrator registers. Passkeys are bound to its
   * hostname, so changing the hostname invalidates every existing passkey.
   */
  origin: z.url().nullable(),
  /**
   * IANA zone used when printing times on signed records. Storage is always
   * UTC. Taken from the first administrator's browser at setup.
   */
  timezone: z.string().refine(isTimeZone, "Not a recognised IANA time zone"),
  /**
   * Opt-in: people under the adult age may have accounts. While off, nobody
   * is asked their age and everyone signs for themself.
   */
  minorsEnabled: z.boolean(),
  /**
   * A minor needs a parent or guardian account to sign for them. On by
   * default; it only has an effect once minors are enabled.
   */
  guardiansEnabled: z.boolean(),
  /** People younger than this are minors. */
  adultAge: z.number().int().min(13).max(25),
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
  minorsEnabled: false,
  guardiansEnabled: true,
  adultAge: 18,
  sessionDays: 30,
  backupEveryHours: 24,
  backupKeep: 30,
};

/** Whether guardians are in play: the site takes minors, and requires a guardian for them. */
export function guardianship(
  settings: Pick<Settings, "minorsEnabled" | "guardiansEnabled">,
): boolean {
  return settings.minorsEnabled && settings.guardiansEnabled;
}

export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
