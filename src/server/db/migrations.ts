import type { Kysely } from "kysely";
import {
  type Migration,
  type MigrationProvider,
  Migrator,
} from "kysely/migration";

// Migrations live in code, not in files, because a Worker has no filesystem.
// Never edit a migration that has shipped; add a new one.

const migrations: Record<string, Migration> = {
  "0001_initial": {
    async up(db: Kysely<unknown>) {
      await db.schema
        .createTable("settings")
        .addColumn("key", "text", (c) => c.primaryKey())
        .addColumn("value", "text", (c) => c.notNull())
        .addColumn("updated_at", "text", (c) => c.notNull())
        .addColumn("updated_by", "text")
        .execute();

      await db.schema
        .createTable("users")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("name", "text", (c) => c.notNull())
        .addColumn("birthdate", "text")
        .addColumn("is_admin", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("managed", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("disabled_at", "text")
        .execute();

      await db.schema
        .createTable("credentials")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("user_id", "text", (c) =>
          c.notNull().references("users.id").onDelete("cascade"),
        )
        .addColumn("public_key", "text", (c) => c.notNull())
        .addColumn("counter", "integer", (c) => c.notNull())
        .addColumn("transports", "text", (c) => c.notNull())
        .addColumn("label", "text", (c) => c.notNull())
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("last_used_at", "text")
        .execute();
      await db.schema
        .createIndex("credentials_user")
        .on("credentials")
        .column("user_id")
        .execute();

      await db.schema
        .createTable("sessions")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("user_id", "text", (c) =>
          c.notNull().references("users.id").onDelete("cascade"),
        )
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("expires_at", "text", (c) => c.notNull())
        .addColumn("user_agent", "text", (c) => c.notNull())
        .execute();

      await db.schema
        .createTable("challenges")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("challenge", "text", (c) => c.notNull())
        .addColumn("kind", "text", (c) => c.notNull())
        .addColumn("payload", "text", (c) => c.notNull())
        .addColumn("expires_at", "text", (c) => c.notNull())
        .execute();

      await db.schema
        .createTable("groups")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("name", "text", (c) => c.notNull())
        .addColumn("code", "text")
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("archived_at", "text")
        .execute();

      await db.schema
        .createTable("group_members")
        .addColumn("group_id", "text", (c) =>
          c.notNull().references("groups.id").onDelete("cascade"),
        )
        .addColumn("user_id", "text", (c) =>
          c.notNull().references("users.id").onDelete("cascade"),
        )
        .addColumn("role", "text", (c) => c.notNull())
        .addColumn("joined_at", "text", (c) => c.notNull())
        .addPrimaryKeyConstraint("group_members_pk", ["group_id", "user_id"])
        .execute();
      await db.schema
        .createIndex("group_members_user")
        .on("group_members")
        .column("user_id")
        .execute();

      await db.schema
        .createTable("invites")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("token_hash", "text", (c) => c.notNull().unique())
        .addColumn("token", "text")
        .addColumn("kind", "text", (c) => c.notNull())
        .addColumn("group_id", "text", (c) =>
          c.references("groups.id").onDelete("cascade"),
        )
        .addColumn("target_user_id", "text", (c) =>
          c.references("users.id").onDelete("cascade"),
        )
        .addColumn("created_by", "text", (c) =>
          c.notNull().references("users.id"),
        )
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("expires_at", "text")
        .addColumn("max_uses", "integer")
        .addColumn("uses", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("revoked_at", "text")
        .execute();

      await db.schema
        .createTable("guardianships")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("guardian_id", "text", (c) =>
          c.notNull().references("users.id").onDelete("cascade"),
        )
        .addColumn("ward_id", "text", (c) =>
          c.notNull().references("users.id").onDelete("cascade"),
        )
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("verified_at", "text")
        .addColumn("verified_by", "text")
        .addUniqueConstraint("guardianships_pair", ["guardian_id", "ward_id"])
        .execute();
      await db.schema
        .createIndex("guardianships_ward")
        .on("guardianships")
        .column("ward_id")
        .execute();

      await db.schema
        .createTable("clearances")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("name", "text", (c) => c.notNull())
        .addColumn("description", "text", (c) => c.notNull())
        .addColumn("kind", "text", (c) => c.notNull())
        .addColumn("required_for_all", "integer", (c) =>
          c.notNull().defaultTo(0),
        )
        .addColumn("validity_days", "integer")
        .addColumn("minor_policy", "text", (c) => c.notNull())
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("archived_at", "text")
        .execute();

      await db.schema
        .createTable("document_versions")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("clearance_id", "text", (c) =>
          c.notNull().references("clearances.id").onDelete("cascade"),
        )
        .addColumn("version", "integer", (c) => c.notNull())
        .addColumn("title", "text", (c) => c.notNull())
        .addColumn("body", "text", (c) => c.notNull())
        .addColumn("fields", "text", (c) => c.notNull())
        .addColumn("body_hash", "text", (c) => c.notNull())
        .addColumn("supersedes", "integer", (c) => c.notNull().defaultTo(1))
        .addColumn("published_at", "text", (c) => c.notNull())
        .addColumn("published_by", "text", (c) => c.notNull())
        .addUniqueConstraint("document_versions_number", [
          "clearance_id",
          "version",
        ])
        .execute();

      // Signed records and grants are evidence. They reference users without
      // ON DELETE CASCADE on purpose: a person cannot be deleted out from
      // under a record they signed.
      await db.schema
        .createTable("signatures")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("clearance_id", "text", (c) =>
          c.notNull().references("clearances.id"),
        )
        .addColumn("document_version_id", "text", (c) =>
          c.notNull().references("document_versions.id"),
        )
        .addColumn("subject_id", "text", (c) =>
          c.notNull().references("users.id"),
        )
        .addColumn("signer_id", "text", (c) =>
          c.notNull().references("users.id"),
        )
        .addColumn("capacity", "text", (c) => c.notNull())
        .addColumn("answers", "text", (c) => c.notNull())
        .addColumn("record", "text", (c) => c.notNull())
        .addColumn("record_hash", "text", (c) => c.notNull())
        .addColumn("credential_id", "text", (c) => c.notNull())
        .addColumn("public_key", "text", (c) => c.notNull())
        .addColumn("authenticator_data", "text", (c) => c.notNull())
        .addColumn("client_data_json", "text", (c) => c.notNull())
        .addColumn("signature", "text", (c) => c.notNull())
        .addColumn("signed_at", "text", (c) => c.notNull())
        .addColumn("ip", "text", (c) => c.notNull())
        .addColumn("user_agent", "text", (c) => c.notNull())
        .addColumn("pdf", "text", (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex("signatures_subject")
        .on("signatures")
        .columns(["subject_id", "clearance_id"])
        .execute();

      await db.schema
        .createTable("grants")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("clearance_id", "text", (c) =>
          c.notNull().references("clearances.id"),
        )
        .addColumn("user_id", "text", (c) => c.notNull().references("users.id"))
        .addColumn("document_version_id", "text", (c) =>
          c.references("document_versions.id"),
        )
        .addColumn("source", "text", (c) => c.notNull())
        .addColumn("granted_by", "text")
        .addColumn("granted_at", "text", (c) => c.notNull())
        .addColumn("expires_at", "text")
        .addColumn("signed_as_minor", "integer", (c) =>
          c.notNull().defaultTo(0),
        )
        .addColumn("revoked_at", "text")
        .addColumn("revoked_by", "text")
        .addColumn("revoke_reason", "text")
        .execute();
      await db.schema
        .createIndex("grants_user")
        .on("grants")
        .columns(["user_id", "clearance_id"])
        .execute();

      await db.schema
        .createTable("audit_log")
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("at", "text", (c) => c.notNull())
        .addColumn("actor_id", "text")
        .addColumn("action", "text", (c) => c.notNull())
        .addColumn("subject_type", "text", (c) => c.notNull())
        .addColumn("subject_id", "text", (c) => c.notNull())
        .addColumn("detail", "text", (c) => c.notNull())
        .addColumn("ip", "text", (c) => c.notNull())
        .execute();
      await db.schema
        .createIndex("audit_log_at")
        .on("audit_log")
        .column("at")
        .execute();
    },
  },
};

const provider: MigrationProvider = {
  getMigrations: async () => migrations,
};

export async function migrateToLatest(db: Kysely<any>): Promise<string[]> {
  const { error, results } = await new Migrator({
    db,
    provider,
  }).migrateToLatest();
  if (error) throw error;
  return (results ?? [])
    .filter((r) => r.status === "Success")
    .map((r) => r.migrationName);
}
