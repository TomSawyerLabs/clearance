// The whole schema uses only `text` and `integer` so that it is identical on
// SQLite, Postgres and D1. IDs are UUIDs, timestamps are ISO-8601 UTC strings,
// booleans are 0/1, and JSON or binary values are stored as text.

export type Bool = 0 | 1;

export interface SettingsTable {
  key: string;
  value: string;
  updated_at: string;
  updated_by: string | null;
}

export interface UsersTable {
  id: string;
  name: string;
  /** `YYYY-MM-DD`. Only collected from people who say they are under the adult age. */
  birthdate: string | null;
  is_admin: Bool;
  /** 1 while the account has no passkey of its own and is run by a guardian. */
  managed: Bool;
  created_at: string;
  disabled_at: string | null;
}

export interface CredentialsTable {
  /** The WebAuthn credential ID, base64url. */
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

export interface SessionsTable {
  /** SHA-256 of the cookie value, hex. The cookie itself is never stored. */
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  user_agent: string;
}

export interface ChallengesTable {
  id: string;
  challenge: string;
  kind: string;
  payload: string;
  expires_at: string;
}

export interface GroupsTable {
  id: string;
  name: string;
  /** A short identifier the organization uses for the group, such as a team number. */
  code: string | null;
  created_at: string;
  archived_at: string | null;
}

export type GroupRole = "manager" | "member";

export interface GroupMembersTable {
  group_id: string;
  user_id: string;
  role: GroupRole;
  joined_at: string;
}

export type InviteKind =
  | "group_member"
  | "group_manager"
  | "guardian"
  | "claim"
  | "passkey";

export interface InvitesTable {
  id: string;
  token_hash: string;
  /** Kept only for group links, which managers need to show again. Null for account links. */
  token: string | null;
  kind: InviteKind;
  group_id: string | null;
  target_user_id: string | null;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  max_uses: number | null;
  uses: number;
  revoked_at: string | null;
}

export interface GuardianshipsTable {
  id: string;
  guardian_id: string;
  ward_id: string;
  created_at: string;
  /** When a group manager or admin confirmed the guardian is who they say they are. */
  verified_at: string | null;
  verified_by: string | null;
}

export type ClearanceKind = "release" | "certification";
export type MinorPolicy = "guardian" | "guardian_and_minor";

export interface ClearancesTable {
  id: string;
  name: string;
  description: string;
  kind: ClearanceKind;
  required_for_all: Bool;
  validity_days: number | null;
  minor_policy: MinorPolicy;
  created_at: string;
  archived_at: string | null;
}

export interface DocumentVersionsTable {
  id: string;
  clearance_id: string;
  version: number;
  title: string;
  body: string;
  fields: string;
  body_hash: string;
  /** 1 when publishing this version made signatures on earlier versions stale. */
  supersedes: Bool;
  published_at: string;
  published_by: string;
}

export type SignatureCapacity = "self" | "guardian" | "minor";

export interface SignaturesTable {
  id: string;
  clearance_id: string;
  document_version_id: string;
  subject_id: string;
  signer_id: string;
  capacity: SignatureCapacity;
  answers: string;
  record: string;
  record_hash: string;
  credential_id: string;
  /** Copied from the credential, so the record stays verifiable if the passkey is removed. */
  public_key: string;
  authenticator_data: string;
  client_data_json: string;
  signature: string;
  signed_at: string;
  ip: string;
  user_agent: string;
  pdf: string;
}

export interface GrantsTable {
  id: string;
  clearance_id: string;
  user_id: string;
  document_version_id: string | null;
  source: "signature" | "attestation";
  granted_by: string | null;
  granted_at: string;
  expires_at: string | null;
  signed_as_minor: Bool;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
}

export interface AuditLogTable {
  id: string;
  at: string;
  actor_id: string | null;
  action: string;
  subject_type: string;
  subject_id: string;
  detail: string;
  ip: string;
}

export interface Database {
  settings: SettingsTable;
  users: UsersTable;
  credentials: CredentialsTable;
  sessions: SessionsTable;
  challenges: ChallengesTable;
  groups: GroupsTable;
  group_members: GroupMembersTable;
  invites: InvitesTable;
  guardianships: GuardianshipsTable;
  clearances: ClearancesTable;
  document_versions: DocumentVersionsTable;
  signatures: SignaturesTable;
  grants: GrantsTable;
  audit_log: AuditLogTable;
}
