import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Compilable } from "kysely";
import { z } from "zod";
import type { Settings } from "../../shared/settings.ts";
import {
  badRequest,
  type Caller,
  conflict,
  type Ctx,
  forbidden,
  gone,
  HttpError,
  requireUser,
  unauthorized,
} from "../context.ts";
import type {
  CredentialsTable,
  InvitesTable,
  UsersTable,
} from "../db/schema.ts";
import {
  addDays,
  ageOn,
  fromBase64Url,
  newId,
  randomToken,
  sha256Hex,
  toBase64Url,
} from "../lib/util.ts";
import { audit } from "./audit.ts";
import { consumeInvite, findInvite } from "./invites.ts";
import { getUser } from "./people.ts";
import { getSettings, rpIdOf, settingQueries } from "./settings.ts";

const CHALLENGE_MINUTES = 10;
/** Present in `settings` once the first administrator exists. */
const SETUP_KEY = "_setup";

// ---------------------------------------------------------------------------
// Challenges: one-time values a passkey is asked to sign.

export async function putChallenge(
  ctx: Ctx,
  kind: string,
  challenge: string,
  payload: unknown,
) {
  const id = newId();
  const now = ctx.now();
  await ctx.store.atomic([
    // Clearing out abandoned ceremonies here saves needing a scheduled job,
    // which not every deployment target has.
    ctx.db.deleteFrom("challenges").where("expires_at", "<", now),
    ctx.db.insertInto("challenges").values({
      id,
      challenge,
      kind,
      payload: JSON.stringify(payload),
      expires_at: new Date(
        new Date(now).getTime() + CHALLENGE_MINUTES * 60_000,
      ).toISOString(),
    }),
  ]);
  return id;
}

/** Returns a challenge and destroys it, so a response cannot be replayed. */
export async function takeChallenge<T>(ctx: Ctx, id: string, kind: string) {
  const row = await ctx.db
    .selectFrom("challenges")
    .selectAll()
    .where("id", "=", id)
    .where("kind", "=", kind)
    .executeTakeFirst();
  const deleted = await ctx.db
    .deleteFrom("challenges")
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row || deleted.numDeletedRows !== 1n || row.expires_at <= ctx.now()) {
    throw gone("That took too long. Please try again.");
  }
  return { challenge: row.challenge, payload: JSON.parse(row.payload) as T };
}

// ---------------------------------------------------------------------------
// Sessions

export const SESSION_COOKIE = "clearance_session";

export async function sessionQueries(
  ctx: Ctx,
  userId: string,
  caller: Caller,
  settings: Settings,
) {
  const token = randomToken();
  const now = ctx.now();
  const expiresAt = addDays(now, settings.sessionDays);
  const query = ctx.db.insertInto("sessions").values({
    id: await sha256Hex(token),
    user_id: userId,
    created_at: now,
    expires_at: expiresAt,
    user_agent: caller.userAgent.slice(0, 300),
  });
  return { token, maxAgeSeconds: settings.sessionDays * 86_400, query };
}

export async function userForSession(ctx: Ctx, token: string | undefined) {
  if (!token) return null;
  const row = await ctx.db
    .selectFrom("sessions")
    .innerJoin("users", "users.id", "sessions.user_id")
    .selectAll("users")
    .where("sessions.id", "=", await sha256Hex(token))
    .where("sessions.expires_at", ">", ctx.now())
    .where("users.disabled_at", "is", null)
    .executeTakeFirst();
  return row ?? null;
}

export async function endSession(ctx: Ctx, token: string | undefined) {
  if (!token) return;
  await ctx.db
    .deleteFrom("sessions")
    .where("id", "=", await sha256Hex(token))
    .execute();
}

// ---------------------------------------------------------------------------
// Setup

export async function isSetupNeeded(ctx: Ctx): Promise<boolean> {
  const row = await ctx.db
    .selectFrom("settings")
    .select("key")
    .where("key", "=", SETUP_KEY)
    .executeTakeFirst();
  return !row;
}

/**
 * Exactly one caller can win setup: the primary key on `settings.key` makes
 * the second insert a no-op, on every engine, without a transaction.
 */
async function claimSetup(ctx: Ctx, userId: string): Promise<boolean> {
  const result = await ctx.db
    .insertInto("settings")
    .values({
      key: SETUP_KEY,
      value: JSON.stringify(userId),
      updated_at: ctx.now(),
      updated_by: userId,
    })
    .onConflict((oc) => oc.column("key").doNothing())
    .executeTakeFirst();
  return result.numInsertedOrUpdatedRows === 1n;
}

// ---------------------------------------------------------------------------
// Registering a passkey

export const registerInput = z.object({
  invite: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(100).optional(),
  /** Asked only when guardian support is on. */
  adult: z.boolean().optional(),
  birthdate: z.iso.date().optional(),
  /** `guardian`: a parent using a group link to enrol a child, not to join. */
  as: z.enum(["self", "guardian"]).optional(),
});

type RegisterPlan =
  /** The first administrator. */
  | { mode: "setup"; userId: string; name: string; origin: string }
  /** A new account created through a link. */
  | {
      mode: "invite";
      userId: string;
      name: string;
      birthdate: string | null;
      inviteId: string;
      as: "self" | "guardian";
    }
  /** A passkey for an account that already exists (claim or recovery link). */
  | { mode: "existing"; userId: string; inviteId: string }
  /** A signed-in person adding another device. */
  | { mode: "add"; userId: string };

function originFor(settings: Settings, caller: Caller): string {
  const origin = settings.origin ?? caller.origin;
  if (!origin)
    throw badRequest(
      "The browser did not say which site this request came from.",
    );
  return origin;
}

function birthdateFor(
  input: z.infer<typeof registerInput>,
  settings: Settings,
  now: string,
  mustBeAdult: boolean,
): string | null {
  if (!settings.guardiansEnabled) return null;
  if (input.adult === undefined)
    throw badRequest("Say whether you are an adult.");
  if (input.adult) return null;
  if (!input.birthdate) throw badRequest("A date of birth is needed.");
  const age = ageOn(input.birthdate, now);
  if (age < 0 || age > 120)
    throw badRequest("That date of birth does not look right.");
  // Someone who ticked "under" but is of age is simply an adult.
  if (age >= settings.adultAge) return null;
  if (mustBeAdult) throw forbidden("This link is for an adult.");
  return input.birthdate;
}

export async function registrationOptions(
  ctx: Ctx,
  caller: Caller,
  raw: unknown,
) {
  const parsed = registerInput.safeParse(raw);
  if (!parsed.success)
    throw badRequest("Check the details and try again.", parsed.error.issues);
  const input = parsed.data;
  const settings = await getSettings(ctx);
  const now = ctx.now();

  let plan: RegisterPlan;
  let user: Pick<UsersTable, "id" | "name">;
  let existing: CredentialsTable[] = [];

  if (await isSetupNeeded(ctx)) {
    if (!input.name) throw badRequest("Enter your name.");
    const origin = originFor(settings, caller);
    user = { id: newId(), name: input.name };
    plan = { mode: "setup", userId: user.id, name: input.name, origin };
  } else if (input.invite) {
    const invite = await findInvite(ctx, input.invite);
    if (invite.kind === "claim" || invite.kind === "passkey") {
      user = await getUser(ctx, invite.target_user_id!);
      plan = { mode: "existing", userId: user.id, inviteId: invite.id };
    } else {
      if (caller.user)
        throw conflict("You are already signed in. Accept the link instead.");
      if (!input.name) throw badRequest("Enter your name.");
      const as = input.as ?? "self";
      if (
        as === "guardian" &&
        (invite.kind !== "group_member" || !settings.guardiansEnabled)
      ) {
        throw badRequest("This link cannot be used to enrol a child.");
      }
      const mustBeAdult = as === "guardian" || invite.kind !== "group_member";
      user = { id: newId(), name: input.name };
      plan = {
        mode: "invite",
        userId: user.id,
        name: input.name,
        birthdate: birthdateFor(input, settings, now, mustBeAdult),
        inviteId: invite.id,
        as,
      };
    }
  } else if (caller.user) {
    user = caller.user;
    plan = { mode: "add", userId: user.id };
  } else {
    throw forbidden("You need an invitation link to create an account.");
  }

  if (plan.mode === "existing" || plan.mode === "add") {
    existing = await ctx.db
      .selectFrom("credentials")
      .selectAll()
      .where("user_id", "=", user.id)
      .execute();
  }

  const origin =
    plan.mode === "setup" ? plan.origin : originFor(settings, caller);
  const options = await generateRegistrationOptions({
    rpName: settings.siteName,
    rpID: rpIdOf(origin),
    userName: user.name,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    // A discoverable credential is what lets someone sign in without typing a
    // username; user verification is what makes a sign-off mean a person, not
    // merely a device, was present.
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    excludeCredentials: existing.map((credential) => ({
      id: credential.id,
      transports: JSON.parse(credential.transports) as string[],
    })),
  });

  const challengeId = await putChallenge(
    ctx,
    "register",
    options.challenge,
    plan,
  );
  return { challengeId, options };
}

export const registerVerifyInput = z.object({
  challengeId: z.string(),
  response: z.custom<RegistrationResponseJSON>(
    (value) => typeof value === "object" && !!value,
  ),
  label: z.string().trim().max(80).optional(),
});

export async function registrationVerify(
  ctx: Ctx,
  caller: Caller,
  raw: unknown,
) {
  const parsed = registerVerifyInput.safeParse(raw);
  if (!parsed.success)
    throw badRequest("The passkey response was not understood.");
  const { challenge, payload: plan } = await takeChallenge<RegisterPlan>(
    ctx,
    parsed.data.challengeId,
    "register",
  );
  const settings = await getSettings(ctx);
  const origin =
    plan.mode === "setup" ? plan.origin : originFor(settings, caller);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: parsed.data.response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpIdOf(origin),
      requireUserVerification: true,
    });
  } catch (error) {
    throw badRequest(
      `The passkey could not be verified: ${(error as Error).message}`,
    );
  }
  if (!verification.verified)
    throw badRequest("The passkey could not be verified.");

  const now = ctx.now();
  const { credential } = verification.registrationInfo;
  const credentialRow: CredentialsTable = {
    id: credential.id,
    user_id: plan.userId,
    public_key: toBase64Url(credential.publicKey),
    counter: credential.counter,
    transports: JSON.stringify(credential.transports ?? []),
    label: parsed.data.label || "Passkey",
    created_at: now,
    last_used_at: null,
  };

  const queries: Compilable[] = [];
  const asCaller: Caller = { ...caller, user: null };

  if (plan.mode === "setup") {
    if (!(await claimSetup(ctx, plan.userId))) {
      throw conflict("Someone else finished setting this site up first.");
    }
    queries.push(
      ctx.db.insertInto("users").values({
        id: plan.userId,
        name: plan.name,
        birthdate: null,
        is_admin: 1,
        managed: 0,
        created_at: now,
        disabled_at: null,
      }),
      ...settingQueries(ctx, { origin: plan.origin }, plan.userId),
      audit(
        ctx,
        asCaller,
        "setup.complete",
        "user",
        plan.userId,
        { origin: plan.origin },
        plan.userId,
      ),
    );
  } else if (plan.mode === "invite") {
    const invite = await ctx.db
      .selectFrom("invites")
      .selectAll()
      .where("id", "=", plan.inviteId)
      .executeTakeFirstOrThrow();
    // A parent enrolling a child does not use up the link; the child will.
    if (plan.as === "self") await consumeInvite(ctx, invite.id);
    queries.push(
      ctx.db.insertInto("users").values({
        id: plan.userId,
        name: plan.name,
        birthdate: plan.birthdate,
        is_admin: 0,
        managed: 0,
        created_at: now,
        disabled_at: null,
      }),
    );
    if (plan.as === "self")
      queries.push(...inviteEffect(ctx, invite, plan.userId));
    queries.push(
      audit(
        ctx,
        asCaller,
        "user.register",
        "user",
        plan.userId,
        { invite: invite.id, as: plan.as },
        plan.userId,
      ),
    );
  } else if (plan.mode === "existing") {
    await consumeInvite(ctx, plan.inviteId);
    queries.push(
      ctx.db
        .updateTable("users")
        .set({ managed: 0 })
        .where("id", "=", plan.userId),
      audit(
        ctx,
        asCaller,
        "passkey.add",
        "user",
        plan.userId,
        { invite: plan.inviteId },
        plan.userId,
      ),
    );
  } else {
    if (caller.user?.id !== plan.userId) throw unauthorized();
    queries.push(audit(ctx, caller, "passkey.add", "user", plan.userId));
  }

  queries.push(ctx.db.insertInto("credentials").values(credentialRow));
  const session = await sessionQueries(ctx, plan.userId, caller, settings);
  queries.push(session.query);

  try {
    await ctx.store.atomic(queries);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw conflict("That passkey is already registered.");
  }
  return { userId: plan.userId, session };
}

/**
 * What accepting a link does to the person who accepted it, as queries. Used
 * both when a new account is created through the link and when someone who
 * already has an account opens it.
 */
export function inviteEffect(
  ctx: Ctx,
  invite: InvitesTable,
  userId: string,
): Compilable[] {
  const now = ctx.now();
  switch (invite.kind) {
    case "group_member":
    case "group_manager": {
      const role = invite.kind === "group_manager" ? "manager" : "member";
      return [
        ctx.db
          .insertInto("group_members")
          .values({
            group_id: invite.group_id!,
            user_id: userId,
            role,
            joined_at: now,
          })
          .onConflict((oc) =>
            // Never demote: a manager who opens a member link stays a manager.
            role === "manager"
              ? oc.columns(["group_id", "user_id"]).doUpdateSet({ role })
              : oc.columns(["group_id", "user_id"]).doNothing(),
          ),
      ];
    }
    case "guardian":
      return [
        ctx.db
          .insertInto("guardianships")
          .values({
            id: newId(),
            guardian_id: userId,
            ward_id: invite.target_user_id!,
            created_at: now,
            verified_at: null,
            verified_by: null,
          })
          .onConflict((oc) =>
            oc.columns(["guardian_id", "ward_id"]).doNothing(),
          ),
      ];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Signing in

export async function loginOptions(ctx: Ctx, caller: Caller) {
  const settings = await getSettings(ctx);
  const options = await generateAuthenticationOptions({
    rpID: rpIdOf(originFor(settings, caller)),
    userVerification: "required",
    // No allow-list: the browser offers whichever passkeys it holds for this site.
  });
  const challengeId = await putChallenge(ctx, "login", options.challenge, {});
  return { challengeId, options };
}

export const assertionInput = z.object({
  challengeId: z.string(),
  response: z.custom<AuthenticationResponseJSON>(
    (value) => typeof value === "object" && !!value,
  ),
});

/**
 * Checks a passkey assertion against the stored credential and returns the
 * credential with the counter update to apply. Shared by sign-in and sign-off.
 */
export async function verifyAssertion(
  ctx: Ctx,
  caller: Caller,
  settings: Settings,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
) {
  const credential = await ctx.db
    .selectFrom("credentials")
    .selectAll()
    .where("id", "=", response.id)
    .executeTakeFirst();
  if (!credential) throw unauthorized("That passkey is not registered here.");

  const origin = originFor(settings, caller);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpIdOf(origin),
      requireUserVerification: true,
      credential: {
        id: credential.id,
        publicKey: fromBase64Url(credential.public_key),
        counter: credential.counter,
        transports: JSON.parse(credential.transports),
      },
    });
  } catch (error) {
    throw unauthorized(
      `The passkey could not be verified: ${(error as Error).message}`,
    );
  }
  if (!verification.verified)
    throw unauthorized("The passkey could not be verified.");

  const touch = ctx.db
    .updateTable("credentials")
    .set({
      counter: verification.authenticationInfo.newCounter,
      last_used_at: ctx.now(),
    })
    .where("id", "=", credential.id);
  return { credential, touch };
}

export async function loginVerify(ctx: Ctx, caller: Caller, raw: unknown) {
  const parsed = assertionInput.safeParse(raw);
  if (!parsed.success)
    throw badRequest("The passkey response was not understood.");
  const { challenge } = await takeChallenge(
    ctx,
    parsed.data.challengeId,
    "login",
  );
  const settings = await getSettings(ctx);
  const { credential, touch } = await verifyAssertion(
    ctx,
    caller,
    settings,
    parsed.data.response,
    challenge,
  );
  const user = await getUser(ctx, credential.user_id);
  if (user.disabled_at) throw forbidden("This account has been turned off.");

  const session = await sessionQueries(ctx, user.id, caller, settings);
  await ctx.store.atomic([touch, session.query]);
  return { userId: user.id, session };
}

// ---------------------------------------------------------------------------
// Managing one's own passkeys

export async function listPasskeys(ctx: Ctx, caller: Caller) {
  const user = requireUser(caller);
  return ctx.db
    .selectFrom("credentials")
    .select(["id", "label", "created_at", "last_used_at"])
    .where("user_id", "=", user.id)
    .orderBy("created_at")
    .execute();
}

export async function removePasskey(
  ctx: Ctx,
  caller: Caller,
  credentialId: string,
) {
  const user = requireUser(caller);
  // The "not the last one" rule lives in the DELETE itself so that two
  // concurrent removals cannot leave the account with no way in.
  const result = await ctx.db
    .deleteFrom("credentials")
    .where("id", "=", credentialId)
    .where("user_id", "=", user.id)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("credentials as other")
          .select("other.id")
          .where("other.user_id", "=", user.id)
          .where("other.id", "!=", credentialId),
      ),
    )
    .executeTakeFirst();
  if (result.numDeletedRows !== 1n) {
    throw conflict(
      "You cannot remove your only passkey. Add another one first.",
    );
  }
  await audit(ctx, caller, "passkey.remove", "user", user.id, {
    credential: credentialId,
  }).execute();
}
