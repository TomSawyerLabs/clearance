import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  fromBase64Url,
  sha256,
  toBase64Url,
} from "../../src/server/lib/util.ts";

// A software passkey: what a browser plus a platform authenticator would do,
// so the API can be driven end to end without a browser. ES256 keys,
// "none" attestation, user verification always performed.

type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;

function cborHead(major: number, value: number): number[] {
  if (value < 24) return [(major << 5) | value];
  if (value < 256) return [(major << 5) | 24, value];
  if (value < 65536) return [(major << 5) | 25, value >> 8, value & 0xff];
  throw new Error("CBOR value too large for this encoder");
}

function cbor(value: Cbor): number[] {
  if (typeof value === "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return [...cborHead(3, bytes.length), ...bytes];
  }
  if (value instanceof Uint8Array)
    return [...cborHead(2, value.length), ...value];
  const out = cborHead(5, value.size);
  for (const [key, item] of value) out.push(...cbor(key), ...cbor(item));
  return out;
}

/** WebCrypto returns r||s; WebAuthn wants ASN.1 DER. */
function derSignature(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    const trimmed = [...bytes.slice(start)];
    if (trimmed[0]! & 0x80) trimmed.unshift(0);
    return [0x02, trimmed.length, ...trimmed];
  };
  const r = integer(raw.slice(0, 32));
  const s = integer(raw.slice(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

interface StoredCredential {
  id: Uint8Array;
  privateKey: CryptoKey;
  rpId: string;
  userHandle: Uint8Array;
  counter: number;
}

export class VirtualAuthenticator {
  readonly credentials: StoredCredential[] = [];

  constructor(readonly origin: string) {}

  private async authData(
    rpId: string,
    flags: number,
    counter: number,
    attested?: Uint8Array,
  ) {
    const rpIdHash = await sha256(rpId);
    const count = new Uint8Array(
      [counter >>> 24, counter >>> 16, counter >>> 8, counter].map(
        (n) => n & 0xff,
      ),
    );
    return new Uint8Array([...rpIdHash, flags, ...count, ...(attested ?? [])]);
  }

  private clientData(type: string, challenge: string) {
    return new TextEncoder().encode(
      JSON.stringify({
        type,
        challenge,
        origin: this.origin,
        crossOrigin: false,
      }),
    );
  }

  async create(
    options: PublicKeyCredentialCreationOptionsJSON,
  ): Promise<RegistrationResponseJSON> {
    const rpId = options.rp.id!;
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const id = crypto.getRandomValues(new Uint8Array(32));
    const cose = cbor(
      new Map<number, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromBase64Url(jwk.x!)],
        [-3, fromBase64Url(jwk.y!)],
      ]),
    );
    const attested = new Uint8Array([
      ...new Uint8Array(16),
      0,
      id.length,
      ...id,
      ...cose,
    ]);
    // UP | UV | AT
    const authData = await this.authData(rpId, 0x01 | 0x04 | 0x40, 0, attested);
    const attestationObject = new Uint8Array(
      cbor(
        new Map<string, Cbor>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      ),
    );
    this.credentials.push({
      id,
      privateKey: pair.privateKey,
      rpId,
      userHandle: fromBase64Url(options.user.id),
      counter: 0,
    });
    return {
      id: toBase64Url(id),
      rawId: toBase64Url(id),
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: toBase64Url(
          this.clientData("webauthn.create", options.challenge),
        ),
        attestationObject: toBase64Url(attestationObject),
        transports: ["internal"],
      },
    };
  }

  async get(
    options: PublicKeyCredentialRequestOptionsJSON,
  ): Promise<AuthenticationResponseJSON> {
    const allowed = options.allowCredentials?.map(
      (credential) => credential.id,
    );
    const credential = this.credentials.find(
      (candidate) =>
        candidate.rpId === options.rpId &&
        (!allowed?.length || allowed.includes(toBase64Url(candidate.id))),
    );
    if (!credential)
      throw new Error(
        "NotAllowedError: no matching passkey on this authenticator",
      );
    credential.counter += 1;

    const authData = await this.authData(
      credential.rpId,
      0x01 | 0x04,
      credential.counter,
    );
    const clientDataJSON = this.clientData("webauthn.get", options.challenge);
    const signed = new Uint8Array([
      ...authData,
      ...(await sha256(clientDataJSON)),
    ]);
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        credential.privateKey,
        signed,
      ),
    );
    return {
      id: toBase64Url(credential.id),
      rawId: toBase64Url(credential.id),
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: toBase64Url(clientDataJSON),
        authenticatorData: toBase64Url(authData),
        signature: toBase64Url(derSignature(raw)),
        userHandle: toBase64Url(credential.userHandle),
      },
    };
  }
}
