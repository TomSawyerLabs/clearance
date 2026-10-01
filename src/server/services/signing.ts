import { generateAuthenticationOptions } from "@simplewebauthn/server";
import type { Compilable } from "kysely";
import { z } from "zod";
import {
  type Answers,
  type Capacity,
  checkAnswers,
} from "../../shared/document.ts";
import {
  badRequest,
  type Caller,
  conflict,
  type Ctx,
  forbidden,
  notFound,
  requireUser,
} from "../context.ts";
import type { GrantsTable, SignaturesTable } from "../db/schema.ts";
import {
  addDays,
  canonicalJson,
  fromBase64,
  newId,
  sha256,
  toBase64,
  toBase64Url,
  toHex,
} from "../lib/util.ts";
import { audit } from "./audit.ts";
import {
  assertionInput,
  putChallenge,
  takeChallenge,
  verifyAssertion,
} from "./auth.ts";
import {
  currentVersion,
  getVersion,
  requiredCapacities,
  statusesFor,
} from "./clearances.ts";
import { capacityPhrase, renderRecordPdf } from "./pdf.ts";
import { getUser, isGuardianOf, isMinor, relationTo } from "./people.ts";
import { getSettings, rpIdOf } from "./settings.ts";

/** The words the signer agrees to. Part of the signed record. */
export const SIGNING_STATEMENT =
  "I have read this document in full. I agree to sign it electronically, and I understand that " +
  "approving it with my passkey is my signature and has the same effect as signing on paper.";

/**
 * Exactly what a passkey signs. The WebAuthn challenge is the SHA-256 of this
 * object in canonical JSON, so the signature covers the document text (by
 * hash), who signed, for whom, in what capacity, their answers, and when.
 */
export interface SignedRecord {
  app: "clearance";
  recordVersion: 1;
  id: string;
  site: { name: string; origin: string };
  clearance: { id: string; name: string };
  document: {
    versionId: string;
    version: number;
    title: string;
    sha256: string;
  };
  subject: { id: string; name: string; birthdate: string | null };
  signer: { id: string; name: string };
  capacity: Capacity;
  answers: Answers;
  statement: string;
  signedAt: string;
}

export const signInput = z.object({
  clearanceId: z.string(),
  subjectId: z.string(),
  answers: z.record(z.string(), z.unknown()).default({}),
});

/** What the signing page needs: the text, the questions, and the signer's role. */
export async function signingContext(
  ctx: Ctx,
  caller: Caller,
  clearanceId: string,
  subjectId: string,
) {
  const signer = requireUser(caller);
  await relationTo(ctx, caller, subjectId);
  const settings = await getSettings(ctx);
  const now = ctx.now();
  const [subject, clearance, version] = await Promise.all([
    getUser(ctx, subjectId),
    ctx.db
      .selectFrom("clearances")
      .selectAll()
      .where("id", "=", clearanceId)
      .executeTakeFirst(),
    currentVersion(ctx, clearanceId),
  ]);
  if (!clearance || clearance.archived_at || !version) {
    throw notFound("That clearance is not available to sign.");
  }

  const subjectIsMinor = isMinor(subject, settings, now);
  let capacity: Capacity | null = null;
  let blocked: string | null = null;
  if (signer.id === subject.id) {
    capacity = subjectIsMinor ? "minor" : "self";
  } else if (await isGuardianOf(ctx, signer.id, subject.id)) {
    if (subjectIsMinor) capacity = "guardian";
    else blocked = `${subject.name} is an adult and has to sign personally.`;
  } else {
    blocked = "Only the person, or their parent or guardian, can sign this.";
  }

  const status = (await statusesFor(ctx, settings, [subject]))
    .get(subject.id)
    ?.find((entry) => entry.clearanceId === clearanceId);
  if (capacity && status) {
    const required = requiredCapacities(subject, clearance, settings, now);
    if (status.state === "active")
      blocked = "This is already signed and current.";
    else if (!required.includes(capacity)) {
      blocked =
        "A parent or guardian has to sign this. Ask them to sign in and do it.";
    } else if (status.signed.includes(capacity)) {
      blocked = "You have already signed this. It is waiting on someone else.";
    }
  }

  return {
    settings,
    signer,
    subject,
    subjectIsMinor,
    clearance,
    version,
    capacity: blocked ? null : capacity,
    blocked,
    status: status ?? null,
  };
}

export async function signOptions(ctx: Ctx, caller: Caller, raw: unknown) {
  const parsed = signInput.safeParse(raw);
  if (!parsed.success) throw badRequest("The request was not understood.");
  const context = await signingContext(
    ctx,
    caller,
    parsed.data.clearanceId,
    parsed.data.subjectId,
  );
  if (!context.capacity)
    throw forbidden(context.blocked ?? "You cannot sign this.");
  const { settings, signer, subject, clearance, version, capacity } = context;
  if (!settings.origin) throw badRequest("The site has not been set up yet.");

  const checked = checkAnswers(version.fields, capacity, parsed.data.answers);
  if (!checked.ok)
    throw badRequest("Some answers need attention.", checked.problems);

  const record: SignedRecord = {
    app: "clearance",
    recordVersion: 1,
    id: newId(),
    site: { name: settings.siteName, origin: settings.origin },
    clearance: { id: clearance.id, name: clearance.name },
    document: {
      versionId: version.id,
      version: version.version,
      title: version.title,
      sha256: version.bodyHash,
    },
    subject: {
      id: subject.id,
      name: subject.name,
      birthdate: subject.birthdate,
    },
    signer: { id: signer.id, name: signer.name },
    capacity,
    answers: checked.answers,
    statement: SIGNING_STATEMENT,
    signedAt: ctx.now(),
  };
  const canonical = canonicalJson(record);
  const hash = await sha256(canonical);

  const credentials = await ctx.db
    .selectFrom("credentials")
    .select(["id", "transports"])
    .where("user_id", "=", signer.id)
    .execute();
  const options = await generateAuthenticationOptions({
    rpID: rpIdOf(settings.origin),
    challenge: hash,
    userVerification: "required",
    // Only the signer's own passkeys: a sign-off by whoever happens to hold
    // some other passkey on this device would not be the signer's.
    allowCredentials: credentials.map((credential) => ({
      id: credential.id,
      transports: JSON.parse(credential.transports),
    })),
  });

  const challengeId = await putChallenge(ctx, "sign", options.challenge, {
    record: canonical,
    signerId: signer.id,
  });
  return {
    challengeId,
    options,
    recordHash: toHex(hash),
    statement: SIGNING_STATEMENT,
  };
}

export async function signVerify(ctx: Ctx, caller: Caller, raw: unknown) {
  const signer = requireUser(caller);
  const parsed = assertionInput.safeParse(raw);
  if (!parsed.success)
    throw badRequest("The passkey response was not understood.");
  const { challenge, payload } = await takeChallenge<{
    record: string;
    signerId: string;
  }>(ctx, parsed.data.challengeId, "sign");
  if (payload.signerId !== signer.id)
    throw forbidden("That signing request was not yours.");
  const record = JSON.parse(payload.record) as SignedRecord;

  // Things can change while the passkey prompt is open: re-check the role.
  const context = await signingContext(
    ctx,
    caller,
    record.clearance.id,
    record.subject.id,
  );
  if (context.capacity !== record.capacity) {
    throw conflict(
      context.blocked ??
        "This can no longer be signed as requested. Start again.",
    );
  }
  if (context.version.id !== record.document.versionId) {
    throw conflict(
      "The document was updated while you were signing. Read the new version.",
    );
  }
  const { settings, subject, clearance, subjectIsMinor } = context;
  const version = await getVersion(ctx, record.document.versionId);

  const { credential, touch } = await verifyAssertion(
    ctx,
    caller,
    settings,
    parsed.data.response,
    challenge,
  );
  if (credential.user_id !== signer.id) {
    throw forbidden("That passkey belongs to a different account.");
  }

  const now = ctx.now();
  const recordHash = toHex(await sha256(payload.record));
  const pdf = await renderRecordPdf({
    siteName: record.site.name,
    timezone: settings.timezone,
    clearanceName: record.clearance.name,
    title: version.title,
    version: version.version,
    body: version.body,
    bodyHash: version.bodyHash,
    fields: version.fields,
    answers: record.answers,
    signatureId: record.id,
    subjectName: record.subject.name,
    subjectBirthdate: record.subject.birthdate,
    signerName: record.signer.name,
    capacity: record.capacity,
    statement: record.statement,
    signedAt: record.signedAt,
    ip: caller.ip,
    recordHash,
    credentialId:
      credential.id.length > 64
        ? `${credential.id.slice(0, 64)}…`
        : credential.id,
  });

  const row: SignaturesTable = {
    id: record.id,
    clearance_id: record.clearance.id,
    document_version_id: record.document.versionId,
    subject_id: record.subject.id,
    signer_id: signer.id,
    capacity: record.capacity,
    answers: JSON.stringify(record.answers),
    record: payload.record,
    record_hash: recordHash,
    credential_id: credential.id,
    public_key: credential.public_key,
    authenticator_data: parsed.data.response.response.authenticatorData,
    client_data_json: parsed.data.response.response.clientDataJSON,
    signature: parsed.data.response.response.signature,
    signed_at: record.signedAt,
    ip: caller.ip,
    user_agent: caller.userAgent.slice(0, 300),
    pdf: toBase64(pdf),
  };

  const queries: Compilable[] = [
    ctx.db.insertInto("signatures").values(row),
    touch,
    audit(ctx, caller, "signature.create", "user", subject.id, {
      signature: row.id,
      clearance: clearance.id,
      capacity: row.capacity,
    }),
  ];

  // Everyone required has signed once this signature is counted: grant it.
  const required = requiredCapacities(subject, clearance, settings, now);
  const have = new Set<Capacity>([
    ...(context.status?.signed ?? []),
    record.capacity,
  ]);
  let grant: GrantsTable | null = null;
  if (required.every((capacity) => have.has(capacity))) {
    grant = {
      id: newId(),
      clearance_id: clearance.id,
      user_id: subject.id,
      document_version_id: version.id,
      source: "signature",
      granted_by: null,
      granted_at: now,
      expires_at: clearance.validity_days
        ? addDays(now, clearance.validity_days)
        : null,
      signed_as_minor: subjectIsMinor ? 1 : 0,
      revoked_at: null,
      revoked_by: null,
      revoke_reason: null,
    };
    queries.push(
      ctx.db.insertInto("grants").values(grant),
      audit(ctx, caller, "grant.create", "user", subject.id, {
        grant: grant.id,
        clearance: clearance.id,
      }),
    );
  }

  await ctx.store.atomic(queries);
  return {
    signatureId: row.id,
    granted: Boolean(grant),
    expiresAt: grant?.expires_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Reading signed records back

async function loadSignature(ctx: Ctx, caller: Caller, id: string) {
  const row = await ctx.db
    .selectFrom("signatures")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw notFound("That record does not exist.");
  // The signer keeps access to what they signed even if the link to the
  // subject is later removed.
  if (caller.user?.id !== row.signer_id)
    await relationTo(ctx, caller, row.subject_id);
  return row;
}

export async function getSignature(ctx: Ctx, caller: Caller, id: string) {
  const row = await loadSignature(ctx, caller, id);
  const record = JSON.parse(row.record) as SignedRecord;
  return {
    id: row.id,
    record,
    recordHash: row.record_hash,
    capacityPhrase: capacityPhrase({
      capacity: row.capacity,
      subjectName: record.subject.name,
    }),
    signedAt: row.signed_at,
    ip: row.ip,
    /** Everything needed to check the signature without this application. */
    evidence: {
      canonicalRecord: row.record,
      credentialId: row.credential_id,
      publicKey: row.public_key,
      authenticatorData: row.authenticator_data,
      clientDataJSON: row.client_data_json,
      signature: row.signature,
      challenge: toBase64Url(await sha256(row.record)),
    },
  };
}

export async function getSignaturePdf(ctx: Ctx, caller: Caller, id: string) {
  const row = await loadSignature(ctx, caller, id);
  const record = JSON.parse(row.record) as SignedRecord;
  const slug = `${record.document.title} ${record.subject.name}`
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return { bytes: fromBase64(row.pdf), filename: `${slug || "record"}.pdf` };
}
