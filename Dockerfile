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
RUN useradd --uid 10001 --user-group --no-create-home clearance \
  && mkdir /data && chown clearance:clearance /data
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
