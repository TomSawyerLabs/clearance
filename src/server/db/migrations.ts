import { type Kysely, sql } from "kysely";

// Migrations live in code, not in files, because a Worker has no filesystem.
// This is a deliberately small runner instead of Kysely's Migrator: that one
// inspects the schema with queries D1 refuses (SQLITE_AUTH).
//
// Rules for writing one:
//   - Never edit a migration that has shipped; add a new one.
//   - Make it safe to run twice (`ifNotExists`). Two server processes, or two
//     Worker isolates, can start at the same moment and both try to apply it.
//   - Only `text` and `integer` columns, so it means the same on every engine.

interface Migration {
  name: string;
  up(db: Kysely<any>): Promise<void>;
}

const migrations: Migration[] = [
  {
    name: "0001_initial",
    async up(db) {
      await db.schema
        .createTable("settings")
        .ifNotExists()
        .addColumn("key", "text", (c) => c.primaryKey())
        .addColumn("value", "text", (c) => c.notNull())
        .addColumn("updated_at", "text", (c) => c.notNull())
        .addColumn("updated_by", "text")
        .execute();

      await db.schema
        .createTable("users")
        .ifNotExists()
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
        .ifNotExists()
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
        .ifNotExists()
        .on("credentials")
        .column("user_id")
        .execute();

      await db.schema
        .createTable("sessions")
        .ifNotExists()
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
        .ifNotExists()
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("challenge", "text", (c) => c.notNull())
        .addColumn("kind", "text", (c) => c.notNull())
        .addColumn("payload", "text", (c) => c.notNull())
        .addColumn("expires_at", "text", (c) => c.notNull())
        .execute();

      await db.schema
        .createTable("groups")
        .ifNotExists()
        .addColumn("id", "text", (c) => c.primaryKey())
        .addColumn("name", "text", (c) => c.notNull())
        .addColumn("code", "text")
        .addColumn("created_at", "text", (c) => c.notNull())
        .addColumn("archived_at", "text")
        .execute();

      await db.schema
        .createTable("group_members")
        .ifNotExists()
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
        .ifNotExists()
        .on("group_members")
        .column("user_id")
        .execute();

      await db.schema
        .createTable("invites")
        .ifNotExists()
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
        .ifNotExists()
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
        .ifNotExists()
        .on("guardianships")
        .column("ward_id")
        .execute();

      await db.schema
        .createTable("clearances")
        .ifNotExists()
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
        .ifNotExists()
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
        .ifNotExists()
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
        .ifNotExists()
        .on("signatures")
        .columns(["subject_id", "clearance_id"])
        .execute();

      await db.schema
        .createTable("grants")
        .ifNotExists()
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
        .ifNotExists()
        .on("grants")
        .columns(["user_id", "clearance_id"])
        .execute();

      await db.schema
        .createTable("audit_log")
        .ifNotExists()
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
        .ifNotExists()
        .on("audit_log")
        .column("at")
        .execute();
    },
  },
];

/** Applies whatever has not been applied yet and returns the names it applied. */
/** The names of the migrations this database has had, oldest first. */
export async function appliedMigrations(db: Kysely<any>): Promise<string[]> {
  const done = await sql<{
    name: string;
  }>`select name from clearance_migrations order by name`.execute(db);
  return done.rows.map((row) => row.name);
}

export async function migrateToLatest(db: Kysely<any>): Promise<string[]> {
  await db.schema
    .createTable("clearance_migrations")
    .ifNotExists()
    .addColumn("name", "text", (c) => c.primaryKey())
    .addColumn("applied_at", "text", (c) => c.notNull())
    .execute();

  const applied = new Set(await appliedMigrations(db));

  const ran: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    await migration.up(db);
    await db
      .insertInto("clearance_migrations")
      .values({ name: migration.name, applied_at: new Date().toISOString() })
      .onConflict((oc) => oc.column("name").doNothing())
      .execute();
    ran.push(migration.name);
  }
  return ran;
}
