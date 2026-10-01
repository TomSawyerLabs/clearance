import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type * as adminService from "../server/services/admin.ts";
import type { listAudit } from "../server/services/audit.ts";
import type * as authService from "../server/services/auth.ts";
import type * as clearanceService from "../server/services/clearances.ts";
import type * as familyService from "../server/services/family.ts";
import type * as groupService from "../server/services/groups.ts";
import type { PersonSummary } from "../server/services/people.ts";
import type * as signingService from "../server/services/signing.ts";
import type { Capacity } from "../shared/document.ts";
import type { Settings } from "../shared/settings.ts";

// The response types are taken straight from the server's service functions
// (type-only imports, erased at build time), so the UI cannot drift from the API.

type Result<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

export type Group = Result<typeof groupService.getGroup>;
export type GroupListItem = Result<typeof groupService.listGroups>[number];
export type InviteInfo = Result<typeof groupService.describeInvite>;
export type Family = Result<typeof familyService.getFamily>;
export type Person = Result<typeof adminService.getPerson>;
export type AdminUser = Result<typeof adminService.listUsers>[number];
export type AuditEntry = Result<typeof listAudit>[number];
export type Passkey = Result<typeof authService.listPasskeys>[number];
export type SignedRecordView = Result<typeof signingService.getSignature>;
export type {
  ClearanceDto,
  ClearanceStatus,
  VersionDto,
} from "../server/services/clearances.ts";
export type { Capacity, PersonSummary, Settings };

export interface SiteState {
  setupNeeded: boolean;
  site: {
    name: string;
    timezone: string;
    guardiansEnabled: boolean;
    adultAge: number;
  };
  me: (PersonSummary & { admin: boolean }) | null;
}

export interface SigningPage {
  clearance: { id: string; name: string };
  version: clearanceService.VersionDto;
  subject: { id: string; name: string; minor: boolean };
  signer: { id: string; name: string };
  capacity: Capacity | null;
  blocked: string | null;
  status: clearanceService.ClearanceStatus | null;
  statement: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      response.status,
      data?.error ?? `The server replied ${response.status}.`,
      data?.details ?? null,
    );
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>("GET", path);
export const post = <T>(path: string, body: unknown = {}) =>
  api<T>("POST", path, body);

/** Turns whatever a passkey prompt or request threw into a sentence for the person. */
export function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) {
    if (error.name === "NotAllowedError") {
      return "The passkey prompt was closed or timed out. Nothing was changed.";
    }
    if (error.name === "InvalidStateError") {
      return "This device already has a passkey for this account.";
    }
    return error.message;
  }
  return "Something went wrong.";
}

/** A name for a new passkey that will mean something in a list later. */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const system = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "Mac"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "device";
  return `${browser} on ${system}`;
}

export interface RegisterInput {
  invite?: string;
  name?: string;
  adult?: boolean;
  birthdate?: string;
  as?: "self" | "guardian";
}

/** Creates a passkey. The server decides what it is for from the input and the session. */
export async function registerPasskey(
  input: RegisterInput,
): Promise<{ userId: string }> {
  const started = await post<Result<typeof authService.registrationOptions>>(
    "/auth/register/options",
    input,
  );
  const response = await startRegistration({ optionsJSON: started.options });
  return post("/auth/register/verify", {
    challengeId: started.challengeId,
    response,
    label: deviceLabel(),
  });
}

export async function signIn(): Promise<{ userId: string }> {
  const started = await post<Result<typeof authService.loginOptions>>(
    "/auth/login/options",
  );
  const response = await startAuthentication({ optionsJSON: started.options });
  return post("/auth/login/verify", {
    challengeId: started.challengeId,
    response,
  });
}

export async function signDocument(
  clearanceId: string,
  subjectId: string,
  answers: Record<string, string | boolean>,
) {
  const started = await post<Result<typeof signingService.signOptions>>(
    "/sign/options",
    {
      clearanceId,
      subjectId,
      answers,
    },
  );
  const response = await startAuthentication({ optionsJSON: started.options });
  return post<Result<typeof signingService.signVerify>>("/sign/verify", {
    challengeId: started.challengeId,
    response,
  });
}
