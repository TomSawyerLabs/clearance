# Clearance

Clearance records who is cleared to do what. People sign documents, such as a liability release,
with a passkey, and the people who run a group can see at a glance who has signed and who has not.

It was built for a robotics maker space whose students need a release signed by a parent, but
nothing in it is specific to that.

**Status: early.** Signed releases work end to end. Training certifications are designed for but
not built. Read [What is not done](#what-is-not-done) before relying on it.

## What it does

- **Passkeys only.** There are no passwords and no email. People sign in with their device's
  fingerprint, face or PIN. Accounts are created from invitation links.
- **A sign-off is a passkey signature.** The passkey signs a hash of the exact record: the document
  text, who signed, for whom, in what role, their answers, and the time. The record, the signature
  and the public key are stored together, so a sign-off can be verified later without this
  application. A PDF copy is produced at the moment of signing.
- **Groups with managers.** A manager hands out a link (or a QR code). Everyone who joins through it
  lands in the group, and the manager sees each member's status.
- **Parents and guardians, if you turn it on.** A guardian has their own account and is linked to a
  child's. A parent can enrol a child and sign for them, or a student can sign up first and send a
  parent a link. When the child comes of age, the guardian's signature stops counting.
- **Versioned documents.** Documents are written in Markdown with optional questions. Publishing a
  change makes a new version; you choose whether everyone has to sign again. A document can be
  loaded from and downloaded as files, and its fingerprint checked with `clearance hash`, so the
  wording can live in version control.
- **Backups that move between databases.** One file holds everything, is written automatically on
  a schedule, and restores onto any supported database.
- **One organization per installation.** The first person to register becomes the administrator.
  Every setting is changed in the web UI, not in configuration files.

## Run it

Clearance is one process with an embedded database by default. Open it over HTTPS (passkeys require
it), or on `http://localhost` to try it out. The first visitor becomes the administrator, so visit
it yourself straight away.

| How                                       | Command                                               |
| ----------------------------------------- | ----------------------------------------------------- |
| Single executable (Windows, macOS, Linux) | `./clearance`                                         |
| From source                               | `bun install && bun run build && bun run start`       |
| Docker                                    | `docker compose -f deploy/compose.sqlite.yml up -d`   |
| Docker with Postgres                      | `docker compose -f deploy/compose.postgres.yml up -d` |
| Cloudflare Workers with D1                | `bun run worker:deploy`                               |

Only the database and the listener are configured from the environment:

| Variable           | Default                      | Meaning                                                                       |
| ------------------ | ---------------------------- | ----------------------------------------------------------------------------- |
| `DATABASE_URL`     | `sqlite:./data/clearance.db` | `sqlite:<path>` for the embedded database, or `postgres://...`                |
| `HOST`, `PORT`     | `127.0.0.1`, `8080`          | Where to listen                                                               |
| `SOCKET_PATH`      | unset                        | Listen on a unix socket instead, for a reverse proxy on the same host         |
| `CLIENT_IP_HEADER` | unset                        | The header your reverse proxy puts the visitor's address in, e.g. `X-Real-IP` |
| `BACKUP_DIR`       | beside the database          | Where automatic backups are written                                           |

[docs/deploy.md](docs/deploy.md) covers each option in detail, including reverse proxies, backups
and what to do if you lock yourself out.

## Develop

```sh
bun install
bun run dev          # API with reload, and the UI on http://localhost:5173
bun run typecheck
bun run test         # API scenarios on SQLite and Postgres, and the Worker on local D1
bun run test:e2e     # the whole flow in a real browser with a virtual passkey
bun run fmt
bun run compile all  # executables for every platform, in dist/
```

The tests need no services: Postgres is [PGlite](https://pglite.dev) in-process, and D1 is
`wrangler dev` running locally.

### Layout

| Path                   | What is there                                                       |
| ---------------------- | ------------------------------------------------------------------- |
| `src/server/`          | The API as one `fetch` handler, with no knowledge of Bun or Workers |
| `src/server/db/`       | Schema, migrations, and the drivers for SQLite and D1               |
| `src/server/services/` | The rules: accounts, groups, guardians, clearances, signing, PDF    |
| `src/shared/`          | Code used by both sides: the document model and the settings        |
| `src/client/`          | The React UI                                                        |
| `src/entry/`           | `bun.ts` for servers and containers, `worker.ts` for Cloudflare     |
| `test/`, `e2e/`        | API scenarios, the Worker test, and the browser test                |
| `plans/`               | Design notes and decisions                                          |

Three rules keep it portable across databases; they are enforced by the tests running on every
engine:

1. Columns are only `text` or `integer`. Times are ISO-8601 UTC text.
2. No interactive transactions, because D1 has none. Writes that must happen together go through
   `store.atomic([...])`.
3. Races are closed by a single conditional statement (for example, a link's use count is checked
   inside the `UPDATE` that increments it).

## What is not done

- **Certifications.** A clearance granted by a mentor's attestation instead of a signature. The
  data model has a place for it; nothing else does.
- **Per-group requirements.** A document is either required of everyone in any group, or optional.
- **Names outside Western European alphabets print as `?` in the PDF.** The PDF uses the built-in
  PDF fonts. The stored record and the web pages are correct; only the PDF rendering is affected.
- **No email.** Nobody is reminded to sign, and signers must download their own copy.
- **No rate limiting.** Put it behind a reverse proxy or Cloudflare if it faces the internet.
- **MySQL** is not supported.
- **The Docker image has not been built by its author's machine**, which has no Docker. The CI
  workflow builds it; the Linux executable it packages has been run under WSL.
- This is software, not legal advice. Whether a release is enforceable depends on its wording and
  your jurisdiction.

## License

MIT
