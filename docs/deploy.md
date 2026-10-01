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

**Backup:** SQLite is in WAL mode, so do not copy the live file. Use
`sqlite3 clearance.db ".backup backup.db"` or `VACUUM INTO`.

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

Then, in **Settings**, set "Where the visitor's network address comes from" to the header your
proxy fills in (`X-Forwarded-For` for Caddy and nginx). Until you do, every signed record shows
the proxy's address. Only choose a header your proxy overwrites: a header passed through from the
visitor can be forged, and the address is printed on signed records.

## Cloudflare Workers

The Worker serves the API, Workers Static Assets serves the UI, and D1 is the database.

```sh
bunx wrangler d1 create clearance     # prints a database_id
# put that id in wrangler.jsonc, under d1_databases
bun run worker:deploy
```

Tables are created on the first request after a deploy; there is no separate migration step. The
visitor's address comes from Cloudflare itself, so leave the network address setting alone.

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
