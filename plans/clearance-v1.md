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
- Where the visitor's network address comes from is an environment setting (`CLIENT_IP_HEADER`),
  not a runtime one: it describes the proxy in front of the app. This narrows the earlier "all
  settings are runtime" rule to settings about the site.
- The site address is an environment setting too (`PUBLIC_BASE_URL`), for the same reason, and is
  shown read-only in Settings. Left unset, the address recorded at setup is used, so that trying
  the app on `localhost` still needs no configuration.
- The time zone is chosen from a list, and starts as the first administrator's browser zone.
- Support for minors is the opt-in (`minorsEnabled`, off by default). Guardians are on by default
  (`guardiansEnabled`) and take effect once minors are enabled. With minors on and guardians off,
  a minor signs for themself.

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
9. [x] Published to GitHub; CI green, including the first container image build.
10. [x] Backups: one portable file, automatic snapshots on the server, restore into an empty
        installation (command line and setup page). Asked for by Cameron, 2026-10-01.
11. [x] Documents as files: load from and download as `.md` + `.fields.json`, one fingerprint
        shared by the server, the editor and `clearance hash`. Asked for by Cameron, 2026-10-01.
        11a. [x] Settings rework asked for by Cameron: minors are the opt-in with guardians on by default,
        a time zone selector seeded from the first administrator's browser, and the proxy header and
        site address moved to the environment (`CLIENT_IP_HEADER`, `PUBLIC_BASE_URL`).
        11b. [x] Configuration file: settings, document rules and groups exported as one JSON file and
        applied back with a preview (UI and `clearance config export` / `apply`). Cameron's idea: the
        private documents repo also holds the configuration. The app does not touch git; a person
        commits the downloaded file. Creates and updates only, never deletes, never publishes text.
12. [x] **Built 2026-10-02 (commit `dc424ab`, CI fix `36d5b94`), all asked for by Cameron in one message:**
        12a. [x] Document variables: deployment facts (legal entity, address, landlord) live in the
        settings and the configuration file as `variables`, and documents say `{{legal_entity}}`.
        Resolved when a version is published, so the stored text and the fingerprint are the words
        people signed; `clearance hash --config FILE` resolves the same way for files on disk.
        12b. [x] Inline questions: `{{question:key}}` on a line of its own places that question in
        the text, on screen and in the PDF, instead of at the end. New question types: `initials`,
        `date`, `multichoice`, `name` (the signer types their own name).
        12c. [x] Certifications, first version: a document of kind `certification` is signed by a
        mentor (a manager of one of the person's groups, or an administrator) in the capacity
        `attester`, with their passkey, and that grants the person the clearance. No guardian is
        involved. Nothing for machines to ask yet.
        12d. [x] Unix socket in the container: the image owns `/run/clearance`, so an empty shared
        volume mounted there takes that ownership (Docker copies the image directory's owner onto
        an empty volume on first mount: `copyExistingContents` in moby's
        `daemon/container/container_unix.go`, which only checks that the volume is empty). The CI
        smoke test proves it with a pre-created volume.
13. [ ] Per-group requirements, a Unicode font for PDFs, email, an API for machines. Not started.
14. [ ] Certifications, later: a per-document rule for who may attest (today: any manager of one
        of the person's groups, or an administrator); a document that both the student signs and a
        mentor attests (today a document has one kind); expiry reminders.

## Findings / gotchas

- **A backup is engine-neutral on purpose.** It is gzipped NDJSON, one row per line, not a copy of
  SQLite's file. That is what lets a backup from one engine restore onto another, and it was
  tested D1 to SQLite and D1 to D1. Sessions and pending passkey challenges are left out.
- **A restore cannot be one transaction** (D1 has none that long), so a failed restore wipes what
  it loaded and leaves the installation empty. It only runs on an empty installation.
- **D1 allows 100 bound parameters per statement**, so restore inserts one row per statement, 25
  statements per batch.
- **The document fingerprint ignores line endings.** Windows checkouts are CRLF; the published
  text is stored with LF and trimmed, and the fingerprint is taken over canonical JSON of title,
  text and questions. Changing this rule changes every fingerprint; do not.
- **Two `wrangler dev` instances need different `--inspector-port`s**, or the second fails.
- **Shell here-documents mangle backslashes in generated TypeScript.** Several patch scripts
  written that way lost `\n`, `\d` and `\\`. Edit source files directly instead. (Happened again
  on 2026-10-02, twice; a Python patch script fed through a here-document is just as affected.
  Use the editor tool for any file with a backslash in it.)
- **`zod`'s `.partial()` fills defaults in for absent keys.** `schema.partial().parse({})` on a
  schema with `.default()` fields returns every default, so a PATCH of one field silently reset
  the others (archiving a group erased its code; saving a document's rules erased its
  description). Patch schemas are written out with `.optional()` and no defaults.
- **A socket in a shared volume needs no root.** Docker's copy-up gives an empty volume the
  ownership of the image directory it is first mounted over (`copyExistingContents` in moby's
  `daemon/container/container_unix.go`; it checks only that the volume is empty). The image owns
  `/run/clearance`, so the unprivileged app creates its socket there. The CI smoke test runs this
  exact scenario, and its first run showed the second half of the story: the default socket mode
  admits only owner and root, so the proxy must run as root (Caddy does) or `SOCKET_MODE` must
  open it.
- **Windows reserves moving port ranges for Hyper-V.** The Worker test's inspector port
  (`port + 1000` = 9797) landed in one (`netsh interface ipv4 show excludedportrange
  protocol=tcp`), and `wrangler dev` died with "access forbidden by its access permissions". It
  is `port + 20000` now.

- **In the browser test, wait for a page's heading before filling a field.** `getByLabel("Name")`
  matched "Site name" on the page being navigated away from, on a slower machine. Required fields
  also carry an asterisk in their accessible name, so match labels by prefix (`/^Name/`), not
  exactly.
- **GHCR image names must be lowercase**, and the organization is `TomSawyerLabs`. The workflow
  lowercases `GITHUB_REPOSITORY`.
- **The GHCR package is created private** even though the repo is public. A host that pulls
  anonymously needs it switched to public in the package's settings.
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
4. Automatic backups stay on the same machine as the database. Should Clearance also push them
   somewhere (S3-compatible storage, for example), or is copying the directory left to the host?

## Things not to do

- Do not use `db.transaction()` in application code; it does not exist on D1.
- Do not bring back Kysely's Migrator; it fails on D1.
- Do not let group managers issue new-passkey links.
- Do not add columns of types other than `text` and `integer`.
- Do not move settings about the site (name, time zone, minors, backups) into environment
  variables, and do not put facts about the deployment (database, listener, public address, proxy
  header) into the admin UI.
- Do not use HTML `title=` attributes for tooltips (Cameron's standing rule).
- Do not put anything specific to one deployment (hostnames, servers, ports) in this repo; it is
  public.

## Progress log

- [x] 2026-10-01: Repo created, dependencies installed, design written.
- [x] 2026-10-01: Server, UI and packaging built. Checks at commit `f6a833a`: typecheck and
      format clean; `bun run test` 24 passing (API scenarios on SQLite and Postgres, Worker on local
      D1, command line, PDF); `bun run test:e2e` passing, also against the compiled Windows
      executable. The Linux executable was run under WSL.
- [x] 2026-10-01: Published. CI on Linux passes typecheck, the API tests (SQLite, Postgres through
      PGlite, the Worker on local D1), the browser test, and builds the image, then starts the
      published image and checks that it serves. It took three runs: the browser test typed into the
      page it was leaving (fixed by waiting for each page's heading), and the image tag needed the
      organization name in lowercase.
- [x] 2026-10-01: Backups and documents-as-files built. `bun run test` 29 passing, including a
      backup restored within each engine, from D1 to SQLite and from D1 to a second D1, and the
      command-line `backup`, `restore` and `hash`. The browser test loads a document from files,
      downloads it back, and restores a backup on a second server's setup page.
- [x] 2026-10-01: Settings rework and the configuration file built. `bun run test` 37 passing;
      the browser test downloads the configuration, previews an edited copy and applies it.
- [ ] Not verified: macOS executables, a real Postgres server (only PGlite), a deployed Worker on
      real D1, real phones and passkey managers.
- [x] 2026-10-02: Variables, placed questions and new question kinds, certifications, the
      socket-owning image. `bun run test` 42 passing on both engines plus the Worker; the browser
      test covers a variable, a placed question and a mentor certifying from the group page; CI
      green with the image started twice, once on a port and once on a socket in a pre-created
      volume.
- [ ] Certifications: who may attest, per document; machine API.
