# syntax=docker/dockerfile:1

# ---- build: compile one executable with the web UI embedded ----
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run compile

# ---- runtime: the executable and nothing else ----
FROM debian:bookworm-slim
# A fixed, unprivileged uid, so a host directory mounted at /data can be
# chowned to it ahead of time.
#
# /run/clearance is where SOCKET_PATH=/run/clearance/clearance.sock puts the
# unix socket for a reverse proxy on the same host. It is owned by the app's
# user here on purpose: when an EMPTY volume is mounted over it, Docker copies
# this directory's ownership onto the volume (the same copy-up that seeds a
# volume with an image's files), so the unprivileged app can create its
# socket in a volume it shares with the proxy without anyone chowning it.
RUN useradd --uid 10001 --user-group --no-create-home clearance \
  && mkdir /data /run/clearance \
  && chown clearance:clearance /data /run/clearance
COPY --from=build /app/dist/clearance /usr/local/bin/clearance

# The embedded database lives on the volume. Point DATABASE_URL at
# postgres://... instead to use a managed database, and drop the volume.
ENV DATABASE_URL=sqlite:/data/clearance.db
ENV HOST=0.0.0.0
ENV PORT=8080
USER clearance
VOLUME ["/data"]
EXPOSE 8080

CMD ["clearance"]
