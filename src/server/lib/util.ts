// Small helpers that must behave identically on Bun and on Cloudflare Workers,
// so everything here is Web Crypto and plain JavaScript.

export function newId(): string {
  return crypto.randomUUID();
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function sha256(
  input: string | Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const data =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : new Uint8Array(input);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  return toHex(await sha256(input));
}

/** A URL-safe secret with 256 bits of entropy, for invite links and session cookies. */
export function randomToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export { canonicalJson } from "../../shared/documentFile.ts";

export function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 86_400_000).toISOString();
}

/** Whole years between a `YYYY-MM-DD` birthdate and an instant, in UTC. */
export function ageOn(birthdate: string, atIso: string): number {
  const [year = 0, month = 1, day = 1] = birthdate.split("-").map(Number);
  const at = new Date(atIso);
  let age = at.getUTCFullYear() - year;
  const beforeBirthday =
    at.getUTCMonth() + 1 < month ||
    (at.getUTCMonth() + 1 === month && at.getUTCDate() < day);
  if (beforeBirthday) age -= 1;
  return age;
}
