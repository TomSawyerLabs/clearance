# Deploying Clearance

Every option below runs the same application. Pick by where you want the data to live.

Two things are true of all of them:

- **Passkeys need HTTPS.** Browsers only allow passkeys on `https://` pages (and on
  `http://localhost`). Serve Clearance behind something that terminates TLS.
- **The first visitor becomes the administrator.** Until someone registers, the site shows a setup
  page to anyone. Open it yourself as soon as it is reachable. The address in your browser at that
  moment is recorded as the site's address.

## Bare metal: one executable, embedded database

Build with `bun run compile` (or `bun run compile linux-x64`, `darwin-arm64`, `windows-x64`, ...,
or `all`). The result in `dist/` contains the server, the web UI and the SQLite engine.

```sh
PORT=8080 ./clearance
```

The database is created at `./data/clearance.db`, relative to where you start it. Set
`DATABASE_URL=sqlite:/var/lib/clearance/clearance.db` to put it somewhere fixed.

To keep it running:

- **Linux (systemd):**

  ```ini
  [Unit]
  Description=Clearance
  After=network.target

  [Service]
  ExecStart=/usr/local/bin/clearance
  Environment=DATABASE_URL=sqlite:/var/lib/clearance/clearance.db
  Environment=PORT=8080
  User=clearance
  StateDirectory=clearance
  Restart=on-failure

  [Install]
  WantedBy=multi-user.target
  ```

- **macOS:** a `launchd` plist with the same program and environment.
- **Windows:** register `clearance.exe` as a service with a service wrapper such as WinSW or NSSM,
  with `DATABASE_URL` and `PORT` set in its environment.

Do not back up by copying the live database file: SQLite is in WAL mode and a copy can be
inconsistent. Use Clearance's own backups, below.

## Bare metal with a managed database

Point `DATABASE_URL` at Postgres. Clearance creates its tables on first start.

```sh
DATABASE_URL=postgres://user:password@db.example.org:5432/clearance ./clearance
```

## Docker

`deploy/compose.sqlite.yml` runs Clearance with its embedded database on a volume.
`deploy/compose.postgres.yml` adds a Postgres container. For a managed Postgres, use the second
file, delete its `postgres` service, and set `DATABASE_URL`.

The container runs as uid 10001 and keeps its data in `/data`. If you bind-mount a host directory
there, `chown 10001` it first.

## Backups

A backup is a single gzipped file containing everything: people, passkeys, groups, documents and
every signed record with its PDF. It is the same format on every kind of installation, so a backup
taken from SQLite restores onto Postgres or D1, and that is also how you move between them.
Sign-ins are not included; people sign in again with the passkeys they already have.

**Automatic backups** are written by the server (not on Workers) to a `backups` directory beside
the SQLite file, or to `./data/backups` when the database is Postgres. Set `BACKUP_DIR` to put
them elsewhere. By default one is written every 24 hours and 30 are kept; both are changed on the
**Backups** page. In the container this is `/data/backups`, inside the data volume.

These protect you from a damaged database, not from losing the machine. Copy the backups
directory somewhere else with whatever you already use for that. The files are complete as soon as
they appear (they are written under a `.partial` name first), so copying them at any time is safe.

**On demand:**

```sh
clearance backup                 # into the backup directory; prints the path
clearance backup /path/to/file   # or to a file you name
```

An administrator can also download one from the **Backups** page. That is the only way on Workers,
alongside D1's own Time Travel.

**Restoring** needs an empty installation, so that a restore can never overwrite live records:

```sh
clearance restore /path/to/clearance-20261001T120000Z.ndjson.gz
```

or choose "Restore from a backup file" on the setup page of a new installation. A backup taken by
a newer version of Clearance is refused; update first. A file that is cut short or damaged is
refused and leaves the installation empty.

The backup carries the site address it was taken from, and passkeys are bound to that hostname.
Restore it behind the same hostname.

## Documents as files

A document's wording can be kept in version control and matched to what was published.

- A document is a Markdown file whose first line is `# Title`, and optionally a JSON file of its
  questions. In the editor, **Load from files** fills in both, and each published version can be
  downloaded back as the same two files.
- Every published version has a fingerprint: the SHA-256 of its title, text and questions. Line
  endings and surrounding blank space do not affect it. The fingerprint is part of every record
  signed against that version.
- `clearance hash release.md release.fields.json` prints the fingerprint those files would have.
  If it equals a published version's, the files are exactly what people signed. It needs no
  database, so it can run in a checkout of the documents, or in that repository's CI.

## Behind a reverse proxy

Listen on loopback or on a unix socket and let the proxy handle TLS. With Caddy:

```
release.example.org {
	reverse_proxy localhost:8080
}
```

or, with `SOCKET_PATH=/run/clearance/clearance.sock`:

```
release.example.org {
	reverse_proxy unix//run/clearance/clearance.sock
}
```

Then tell Clearance which header carries the visitor's address, with the `CLIENT_IP_HEADER`
environment variable:

```sh
CLIENT_IP_HEADER=X-Forwarded-For ./clearance
```

Without it, every signed record shows the proxy's address. Only name a header your proxy
overwrites: a header passed through from the visitor can be forged, and the address is printed on
signed records. This is an environment setting and not one in the admin UI because it describes
what sits in front of the app, which whoever deploys it knows and a site administrator may not.

## Cloudflare Workers

The Worker serves the API, Workers Static Assets serves the UI, and D1 is the database.

```sh
bunx wrangler d1 create clearance     # prints a database_id
# put that id in wrangler.jsonc, under d1_databases
bun run worker:deploy
```

Tables are created on the first request after a deploy; there is no separate migration step. The
visitor's address comes from Cloudflare itself, so there is no `CLIENT_IP_HEADER` to set.

## If you lock yourself out

- **An administrator has lost every passkey.** Another administrator can make them a new-passkey
  link from the **People** page. If there is no other administrator, make the link on the server:

  ```sh
  clearance recovery-link
  ```

  It prints a link that works once and expires in a day. On Workers there is no command line;
  reopen setup instead, and the next person to register becomes an administrator alongside the
  existing accounts. Do it and register immediately, because anyone can claim it while it is open:

  ```sh
  bunx wrangler d1 execute clearance --remote --command "delete from settings where key = '_setup'"
  ```

  Better, add a second passkey on another device from the **Account** page as soon as you finish
  setup.

- **Set the site address wrong.** Requests are refused unless they come from the configured
  address. Fix it from the server:

  ```sh
  clearance config set origin https://release.example.org
  ```

  On Workers:

  ```sh
  bunx wrangler d1 execute clearance --remote \
    --command "update settings set value = '\"https://release.example.org\"' where key = 'origin'"
  ```

- **Changed the hostname.** Passkeys are bound to the hostname they were created on, so every
  existing passkey stops working. Avoid it. If you must, there is currently no migration path short
  of everyone re-registering through new links.
