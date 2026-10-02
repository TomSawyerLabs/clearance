import type { Kysely } from "kysely";
import type { Database, UsersTable } from "./db/schema.ts";
import type { Store } from "./db/store.ts";

/** What every service function needs: the database and the current time. */
export interface Ctx {
  store: Store;
  db: Kysely<Database>;
  /** ISO-8601 UTC. Injected so tests can move the clock. */
  now(): string;
  /**
   * The site's public address when the deployment states it (PUBLIC_BASE_URL).
   * Null means it was not stated, and the address the first administrator
   * registered from is used instead.
   */
  origin: string | null;
}

/** Who is asking, and from where. Built per request. */
export interface Caller {
  user: UsersTable | null;
  ip: string;
  userAgent: string;
  /** The browser-reported origin of the request, when there is one. */
  origin: string | null;
}

export function createCtx(
  store: Store,
  now: () => string = () => new Date().toISOString(),
  origin: string | null = null,
): Ctx {
  return { store, db: store.db, now, origin };
}

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, message, details);
export const unauthorized = (message = "Sign in first.") =>
  new HttpError(401, message);
export const forbidden = (message = "You do not have permission to do that.") =>
  new HttpError(403, message);
export const notFound = (message = "Not found.") => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);
export const gone = (message: string) => new HttpError(410, message);

export function requireUser(caller: Caller): UsersTable {
  if (!caller.user) throw unauthorized();
  return caller.user;
}

export function requireAdmin(caller: Caller): UsersTable {
  const user = requireUser(caller);
  if (!user.is_admin) throw forbidden("Only an administrator can do that.");
  return user;
}
