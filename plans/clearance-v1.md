# Clearance v1

## Goal

Clearance is a standalone app that records who is cleared to do what. A **clearance** is a named
permission a person holds: a signed liability release, and later a training certification. The
first deployment is Tom Sawyer Labs (TSL), a robotics maker space, at
`release.tomsawyerlabs.com`, where students' parents sign a liability release online.

The longer arc, deliberately not built yet: certifications granted by mentors, and an API that a
separate machine-interlock project can ask "may this person run this tool".

## Environment / context

- Repo: `github.com/TomSawyerLabs/clearance`, public, branch `master`.
- The Tom Sawyer Labs release wording, and the plan for TSL's own deployment, are kept in a
  separate private repository. Nothing specific to one deployment belongs in this one.
- Dev machine used so far: Windows 11, Bun 1.4.2, **no Docker and no Postgres installed**, so
  Postgres is exercised through PGlite and the image is built only by CI. WSL (Ubuntu) is
  available for running the Linux executable.

## Decisions already made (don't re-ask)

From Cameron, 2026-10-01:

- Name is Clearance. Own repo. One organization per deployment.
- The first user to register becomes the administrator automatically.
- All settings are changeable at runtime (stored in the database, edited in the admin UI). Only
  what is needed to reach the database and open a listener comes from the environment.
- Passkeys are the only way to authenticate. A sign-off requires a passkey signature.
- Parent/guardian support is opt-in. Guardians have their own accounts; a guardian can also be a
  full participant. Guardianship is stored as a relationship between two accounts.
- Groups with group managers. At TSL a group is a team with a couple of mentors, who hand links to
  students and parents. Then either the guardian signs, or the guardian approves the child's
  account.
- First-class deployment targets: bare metal (macOS, Linux, Windows) with its own embedded
  database; bare metal with a managed database; Docker with or without a database container;
  Cloudflare Workers.
- Scope: one clearance model covering releases and certifications; build releases first;
  certifications second; machine interlock is a separate project.

From Cameron, later on 2026-10-01:

- The repo is public, under the TomSawyerLabs organization.
- Documents are Markdown (accepted; the original ask was HTML).
- A guardian signs for a minor. That is the default; the per-document option to also require the
  student stays, because options are the administrator's to set at runtime.
- Signed releases do not expire by default. Expiry stays as a per-document option.
- Answers to a document's questions are visible to the person's group managers.

Chosen by Claude to satisfy the above (open to change, each is isolated):

- **Runtime:** Bun for bare metal and Docker (`bun build --compile` gives one executable per OS),
  Cloudflare Workers for the edge. No Node target.
- **HTTP:** Hono, because one `fetch` handler runs unchanged on Bun and Workers.
- **Database:** Kysely query builder over three engines: embedded SQLite (`bun:sqlite`), Postgres
  (`pg`), and Cloudflare D1. The drivers for SQLite and D1 are small files in this repo, not
  third-party packages. MySQL is not supported yet.
- **Portable schema:** only `text` and `integer` columns. IDs are UUIDs, timestamps are ISO-8601
  UTC text, booleans are 0/1, JSON and binary are text (binary as base64url).
- **No interactive transactions**, because D1 has none. Multi-statement writes go through
  `atomic()`, which is a transaction on SQLite/Postgres and a `batch` on D1. Races are closed with
  single conditional statements (for example, the first-admin rule is one `INSERT ... SELECT`).
- **Why Markdown and not HTML:** Workers cannot run a headless browser, so HTML-to-PDF is not
  available on every target. Markdown renders to the screen and to PDF (pdf-lib, pure
  JavaScript) from the same parsed blocks. Raw HTML inside a document is ignored.
- **The PDF is produced at signing time** and stored in the database with the signed record.
- **UI:** React single-page app, Mantine components, built by Vite, served by the same process.
- **No email.** Accounts are created only through links; signers download their own PDF copy.

## How a passkey signs a document

1. The server builds a canonical JSON **record**: document version id and SHA-256 of its text,
   the subject, the signer and their capacity (self or guardian), the answers, and the time.
2. The WebAuthn challenge is the SHA-256 of that record. The browser asks the passkey to sign it
   with user verification required.
3. The server verifies the assertion against the signer's stored public key and saves the record,
   the authenticator data, the client data and the signature. Anyone holding those four things
   and the public key can re-verify the sign-off without this app.

## Plan / steps

1. [x] Repo, dependencies, this plan.
2. [x] Server core: database layer and migrations, settings, passkey auth, sessions.
3. [x] Groups, invites, guardianship.
4. [x] Clearances, document versions, signing, PDF.
5. [x] API tests on SQLite and Postgres (PGlite) with a software authenticator.
6. [x] Web UI, with a browser test using a virtual passkey.
7. [x] Packaging: compiled binary, Dockerfile and compose files, Workers config.
8. [x] README and `docs/deploy.md`.
9. [ ] **Current:** published to GitHub; get the first CI run green (it is the first time the
       container image is built).
10. [ ] Certifications (mentor attestation, itself a passkey sign-off). Not started.
11. [ ] Per-group requirements, a Unicode font for PDFs, email. Not started.

## Findings / gotchas

- **Kysely's Migrator does not work on D1.** Its SQLite introspector queries are refused:
  `D1_ERROR: not authorized: SQLITE_AUTH` at `SqliteIntrospector.getTables`. Replaced with a
  small runner in `src/server/db/migrations.ts` that never inspects the schema. Migrations must be
  idempotent (`ifNotExists`), because two processes or isolates can start at once.
- **In Kysely 0.29 the Migrator moved** to `kysely/migration`; importing it from `kysely` is a
  type error. No longer relevant here, noted in case it is reached for again.
- **Miniflare's Node API is not usable for D1 unit tests.** The copy that ships with wrangler
  4.146 is `5.x-alpha` with a different options shape (`Unrecognized keys: "modules", "script",
"d1Databases"`). D1 is covered instead by `test/worker.test.ts`, which runs `wrangler dev`.
- **`wrangler dev` leaves `workerd.exe` running on Windows** when only the parent is killed, and
  the orphan keeps the port, so the next run hangs. The test kills the tree with
  `taskkill /T /F`. If a Worker test hangs, look for stray `workerd.exe`.
- **PGlite takes about 20 seconds to start under Bun on Windows** and resets a second connection
  opened right after the first closes (`ECONNRESET`, `Connection terminated unexpectedly`). The
  harness starts it once per run, keeps one connection, and truncates tables between tests.
- **Hono refuses a cookie `Expires` more than 400 days ahead**, which a test with a moved clock
  hits. The session cookie uses `Max-Age`.
- **`bun test` hooks have their own 5 second timeout**; slow engine start goes in a
  `beforeAll` with an explicit timeout.
- **`bun build --compile` embeds UI files** imported `with { type: "file" }`. The generated entry
  needs `// @ts-nocheck`, and is gitignored (`*.generated.ts`).
- **A passkey's public key is copied onto each signature row.** Otherwise removing a passkey would
  destroy the means of verifying what it signed.
- **Only administrators can issue a new-passkey link.** Group managers were considered and
  rejected: whoever holds the link can sign as that person.
- **"Required" applies to people in a group.** A parent with an account only to sign for a child
  is in no group, and is shown the release as optional.
- **An administrator with no passkey left** recovers with `clearance recovery-link` on the server.
  On Workers the documented route is to delete the `_setup` row, which reopens setup.

## Open questions for the user

1. Is Postgres enough for "managed database", or is MySQL needed too?
2. Should a document be requirable per group, not only "everyone in any group"?
3. PDFs print non-Latin names as "?". Embed a Unicode font (larger PDFs, and a font to ship)?
4. Should Clearance be able to take a document from a file or a git repository, and export its
   published versions, so that wording can be authored and reviewed in git? Today publishing is
   by pasting into the editor.

## Things not to do

- Do not use `db.transaction()` in application code; it does not exist on D1.
- Do not bring back Kysely's Migrator; it fails on D1.
- Do not let group managers issue new-passkey links.
- Do not add columns of types other than `text` and `integer`.
- Do not read configuration from environment variables beyond database and listener settings.
- Do not use HTML `title=` attributes for tooltips (Cameron's standing rule).
- Do not put anything specific to one deployment (hostnames, servers, ports) in this repo; it is
  public.

## Progress log

- [x] 2026-10-01: Repo created, dependencies installed, design written.
- [x] 2026-10-01: Server, UI and packaging built. Checks at commit `f6a833a`: typecheck and
      format clean; `bun run test` 24 passing (API scenarios on SQLite and Postgres, Worker on local
      D1, command line, PDF); `bun run test:e2e` passing, also against the compiled Windows
      executable. The Linux executable was run under WSL.
- [ ] Not verified: the Docker image build (no Docker here), macOS executables, real Postgres
      through anything but PGlite, a deployed Worker on real D1, real phones and passkey managers.
- [ ] First CI run green on GitHub.
- [ ] Certifications.
