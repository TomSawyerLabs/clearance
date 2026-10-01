# Clearance v1

## Goal

Clearance is a standalone app that records who is cleared to do what. A **clearance** is a named
permission a person holds: a signed liability release, and later a training certification. The
first deployment is Tom Sawyer Labs (TSL), a robotics maker space, at
`release.tomsawyerlabs.com`, where students' parents sign a liability release online.

The longer arc, deliberately not built yet: certifications granted by mentors, and an API that a
separate machine-interlock project can ask "may this person run this tool".

## Environment / context

- Repo: `C:\Users\camer\git\Personal Projects\clearance`, branch `master`, no remote yet.
- The TSL release text lives in a sibling repo, `..\tsl-release-form` (its plan:
  `plans/liability-release-form.md`). That plan holds the open questions about the form wording.
- Hosting for TSL goes through `..\ops` (IaC). Nothing there may change without Cameron's explicit
  per-change approval. The pattern is in `ops/servers/steamboat/stacks/README.md`.
- Dev machine: Windows 11, Bun 1.4.2. **No Docker and no Postgres are installed locally**, so the
  Docker image cannot be built here and Postgres is exercised through PGlite.

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
- **Documents are Markdown, not HTML.** Workers cannot run a headless browser, so HTML-to-PDF is
  not available on every target. Markdown renders to HTML for the screen and to PDF (pdf-lib,
  pure JavaScript) from the same parsed tokens. Raw HTML inside a document is ignored.
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
2. [ ] **Current:** Server core: database layer and migrations, settings, passkey auth, sessions.
3. [ ] Groups, invites, guardianship.
4. [ ] Clearances, document versions, signing, PDF.
5. [ ] API tests on SQLite and Postgres (PGlite) with a software authenticator.
6. [ ] Web UI.
7. [ ] Packaging: compiled binary, Dockerfile and compose files, Workers config; smoke tests.
8. [ ] README and deployment docs.
9. [ ] Certifications (mentor attestation). Not started.
10. [ ] TSL deployment through `ops`. Needs Cameron's approval per change.

## Findings / gotchas

(none yet)

## Open questions for the user

1. Documents are Markdown instead of HTML (reason above). Acceptable?
2. Is Postgres enough for "managed database", or is MySQL needed too?
3. Should medical notes be collected online at all? The TSL form asks for them; they are data
   about minors.

## Things not to do

- Do not use `db.transaction()` in application code; it does not exist on D1.
- Do not add columns of types other than `text` and `integer`.
- Do not read configuration from environment variables beyond database and listener settings.
- Do not use HTML `title=` attributes for tooltips (Cameron's standing rule).
- Do not touch `..\ops` without explicit approval.

## Progress log

- [x] 2026-10-01: Repo created, dependencies installed, design written.
