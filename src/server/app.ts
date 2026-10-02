import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  badRequest,
  type Caller,
  type Ctx,
  forbidden,
  HttpError,
  requireAdmin,
  requireUser,
} from "./context.ts";
import * as admin from "./services/admin.ts";
import { audit, listAudit } from "./services/audit.ts";
import * as auth from "./services/auth.ts";
import * as backup from "./services/backup.ts";
import * as clearances from "./services/clearances.ts";
import * as config from "./services/config.ts";
import * as family from "./services/family.ts";
import * as groups from "./services/groups.ts";
import { summarise } from "./services/people.ts";
import { guardianship } from "../shared/settings.ts";
import { getSettings, updateSettings } from "./services/settings.ts";
import * as signing from "./services/signing.ts";

export interface AppOptions {
  ctx: Ctx;
  /**
   * The visitor's address as the runtime knows it, used unless
   * `clientIpHeader` names a proxy header to trust instead.
   */
  clientIp(request: Request): string;
  /**
   * The request header a reverse proxy puts the visitor's address in. It is
   * deployment configuration, not a site setting: it describes what sits in
   * front of the app, and an administrator of the site cannot know that.
   */
  clientIpHeader?: string | null;
  /**
   * Lists the automatic backups this installation has written, newest first.
   * Only an entry point with a disk supplies it.
   */
  snapshots?(): Promise<Snapshot[]>;
}

export interface Snapshot {
  name: string;
  bytes: number;
  at: string;
}

type Env = { Variables: { caller: Caller } };

/**
 * The whole HTTP API as one `fetch` handler. It knows nothing about Bun or
 * Workers; each entry point supplies a database and serves the static files.
 */
export function createApi({
  ctx,
  clientIp,
  clientIpHeader,
  snapshots,
}: AppOptions) {
  const app = new Hono<Env>().basePath("/api");

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json(
        { error: error.message, details: error.details ?? null },
        error.status,
      );
    }
    console.error(error);
    return c.json(
      { error: "Something went wrong on the server.", details: null },
      500,
    );
  });
  app.notFound((c) => c.json({ error: "Not found.", details: null }, 404));

  app.use(async (c, next) => {
    const settings = await getSettings(ctx);
    const origin = c.req.header("origin") ?? null;
    // Cookies are SameSite=Lax, and on top of that every state-changing
    // request must come from the site's own pages.
    if (
      !["GET", "HEAD"].includes(c.req.method) &&
      settings.origin &&
      origin !== settings.origin
    ) {
      throw forbidden(
        `This site is set up as ${settings.origin}, but the request came from ${origin ?? "an unknown page"}.`,
      );
    }
    const forwarded = clientIpHeader
      ? c.req.header(clientIpHeader)?.split(",")[0]?.trim()
      : undefined;
    c.set("caller", {
      user: await auth.userForSession(ctx, getCookie(c, auth.SESSION_COOKIE)),
      ip: forwarded || clientIp(c.req.raw),
      userAgent: c.req.header("user-agent") ?? "",
      origin,
    });
    await next();
  });

  const body = async (c: Context<Env>) =>
    (await c.req.json().catch(() => ({}))) as unknown;

  function startSession(
    c: Context<Env>,
    session: { token: string; maxAgeSeconds: number },
    origin: string | null,
  ) {
    setCookie(c, auth.SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: origin?.startsWith("https://") ?? false,
      path: "/",
      maxAge: session.maxAgeSeconds,
    });
  }

  // --- Session and site state ------------------------------------------------

  app.get("/state", async (c) => {
    const caller = c.get("caller");
    const settings = await getSettings(ctx);
    const [me] = caller.user
      ? await summarise(ctx, settings, [caller.user])
      : [];
    return c.json({
      setupNeeded: await auth.isSetupNeeded(ctx),
      site: {
        name: settings.siteName,
        timezone: settings.timezone,
        /** People under the adult age can have accounts. */
        minorsEnabled: settings.minorsEnabled,
        /** ...and a parent or guardian signs for them. */
        guardiansEnabled: guardianship(settings),
        adultAge: settings.adultAge,
      },
      me: me ? { ...me, admin: caller.user!.is_admin === 1 } : null,
    });
  });

  app.post("/auth/register/options", async (c) =>
    c.json(await auth.registrationOptions(ctx, c.get("caller"), await body(c))),
  );
  app.post("/auth/register/verify", async (c) => {
    const caller = c.get("caller");
    const result = await auth.registrationVerify(ctx, caller, await body(c));
    startSession(
      c,
      result.session,
      (await getSettings(ctx)).origin ?? caller.origin,
    );
    return c.json({ userId: result.userId });
  });
  app.post("/auth/login/options", async (c) =>
    c.json(await auth.loginOptions(ctx, c.get("caller"))),
  );
  app.post("/auth/login/verify", async (c) => {
    const caller = c.get("caller");
    const result = await auth.loginVerify(ctx, caller, await body(c));
    startSession(
      c,
      result.session,
      (await getSettings(ctx)).origin ?? caller.origin,
    );
    return c.json({ userId: result.userId });
  });
  app.post("/auth/logout", async (c) => {
    await auth.endSession(ctx, getCookie(c, auth.SESSION_COOKIE));
    deleteCookie(c, auth.SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  app.get("/me/passkeys", async (c) =>
    c.json(await auth.listPasskeys(ctx, c.get("caller"))),
  );
  app.delete("/me/passkeys/:id", async (c) => {
    await auth.removePasskey(ctx, c.get("caller"), c.req.param("id"));
    return c.json({ ok: true });
  });

  // --- Links -------------------------------------------------------------------

  app.get("/invites/:token", async (c) =>
    c.json(await groups.describeInvite(ctx, c.req.param("token"))),
  );
  app.post("/invites/:token/accept", async (c) =>
    c.json(
      await groups.acceptInvite(ctx, c.get("caller"), c.req.param("token")),
    ),
  );
  app.delete("/invites/:id", async (c) => {
    await groups.revokeInvite(ctx, c.get("caller"), c.req.param("id"));
    return c.json({ ok: true });
  });

  // --- Family ------------------------------------------------------------------

  app.get("/family", async (c) =>
    c.json(await family.getFamily(ctx, c.get("caller"))),
  );
  app.post("/family/wards", async (c) =>
    c.json(await family.addWard(ctx, c.get("caller"), await body(c))),
  );
  app.post("/family/wards/:id/claim-invite", async (c) =>
    c.json(
      await family.wardClaimInvite(ctx, c.get("caller"), c.req.param("id")),
    ),
  );
  app.post("/family/guardian-invite", async (c) =>
    c.json(await family.guardianInvite(ctx, c.get("caller"))),
  );
  app.put("/guardianships/:id/verified", async (c) => {
    const input = (await body(c)) as { verified?: unknown };
    await family.verifyGuardianship(
      ctx,
      c.get("caller"),
      c.req.param("id"),
      input.verified === true,
    );
    return c.json({ ok: true });
  });
  app.delete("/guardianships/:id", async (c) => {
    await family.removeGuardianship(ctx, c.get("caller"), c.req.param("id"));
    return c.json({ ok: true });
  });

  // --- Groups ------------------------------------------------------------------

  app.get("/groups", async (c) =>
    c.json(await groups.listGroups(ctx, c.get("caller"))),
  );
  app.post("/groups", async (c) =>
    c.json(await groups.createGroup(ctx, c.get("caller"), await body(c))),
  );
  app.get("/groups/:id", async (c) =>
    c.json(await groups.getGroup(ctx, c.get("caller"), c.req.param("id"))),
  );
  app.patch("/groups/:id", async (c) => {
    await groups.updateGroup(
      ctx,
      c.get("caller"),
      c.req.param("id"),
      await body(c),
    );
    return c.json({ ok: true });
  });
  app.post("/groups/:id/invites", async (c) =>
    c.json(
      await groups.createGroupInvite(
        ctx,
        c.get("caller"),
        c.req.param("id"),
        await body(c),
      ),
    ),
  );
  app.put("/groups/:id/members/:userId", async (c) => {
    const input = (await body(c)) as { role?: unknown };
    await groups.setMemberRole(
      ctx,
      c.get("caller"),
      c.req.param("id"),
      c.req.param("userId"),
      input.role,
    );
    return c.json({ ok: true });
  });
  app.delete("/groups/:id/members/:userId", async (c) => {
    await groups.removeMember(
      ctx,
      c.get("caller"),
      c.req.param("id"),
      c.req.param("userId"),
    );
    return c.json({ ok: true });
  });

  // --- Clearances and documents ------------------------------------------------

  app.get("/clearances", async (c) =>
    c.json(await clearances.listClearances(ctx, c.get("caller"))),
  );
  app.post("/clearances", async (c) =>
    c.json(
      await clearances.createClearance(ctx, c.get("caller"), await body(c)),
    ),
  );
  app.patch("/clearances/:id", async (c) => {
    await clearances.updateClearance(
      ctx,
      c.get("caller"),
      c.req.param("id"),
      await body(c),
    );
    return c.json({ ok: true });
  });
  app.get("/clearances/:id/versions", async (c) =>
    c.json(
      await clearances.listVersions(ctx, c.get("caller"), c.req.param("id")),
    ),
  );
  app.post("/clearances/:id/versions", async (c) =>
    c.json(
      await clearances.publishVersion(
        ctx,
        c.get("caller"),
        c.req.param("id"),
        await body(c),
      ),
    ),
  );
  app.post("/grants/:id/revoke", async (c) => {
    const input = (await body(c)) as { reason?: unknown };
    await clearances.revokeGrant(
      ctx,
      c.get("caller"),
      c.req.param("id"),
      typeof input.reason === "string" ? input.reason : "",
    );
    return c.json({ ok: true });
  });

  // --- People and signing ------------------------------------------------------

  app.get("/people/:id", async (c) =>
    c.json(await admin.getPerson(ctx, c.get("caller"), c.req.param("id"))),
  );

  app.get("/sign/:clearanceId/:subjectId", async (c) => {
    const context = await signing.signingContext(
      ctx,
      c.get("caller"),
      c.req.param("clearanceId"),
      c.req.param("subjectId"),
    );
    return c.json({
      clearance: { id: context.clearance.id, name: context.clearance.name },
      version: context.version,
      subject: {
        id: context.subject.id,
        name: context.subject.name,
        minor: context.subjectIsMinor,
      },
      signer: { id: context.signer.id, name: context.signer.name },
      capacity: context.capacity,
      blocked: context.blocked,
      status: context.status,
      statement: signing.SIGNING_STATEMENT,
    });
  });
  app.post("/sign/options", async (c) =>
    c.json(await signing.signOptions(ctx, c.get("caller"), await body(c))),
  );
  app.post("/sign/verify", async (c) =>
    c.json(await signing.signVerify(ctx, c.get("caller"), await body(c))),
  );

  app.get("/signatures/:id", async (c) =>
    c.json(await signing.getSignature(ctx, c.get("caller"), c.req.param("id"))),
  );
  app.get("/signatures/:id/pdf", async (c) => {
    const pdf = await signing.getSignaturePdf(
      ctx,
      c.get("caller"),
      c.req.param("id"),
    );
    return new Response(pdf.bytes, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${pdf.filename}"`,
        "cache-control": "private, no-store",
      },
    });
  });

  // --- Administration ----------------------------------------------------------

  app.get("/admin/settings", async (c) => {
    const user = requireUser(c.get("caller"));
    if (!user.is_admin) throw forbidden();
    return c.json({
      ...(await getSettings(ctx)),
      /** Whether the site address was stated by the deployment or recorded at setup. */
      originFromEnvironment: ctx.origin !== null,
    });
  });
  app.patch("/admin/settings", async (c) =>
    c.json(await updateSettings(ctx, c.get("caller"), await body(c))),
  );
  app.get("/admin/users", async (c) =>
    c.json(await admin.listUsers(ctx, c.get("caller"))),
  );
  app.patch("/admin/users/:id", async (c) => {
    await admin.updateUser(
      ctx,
      c.get("caller"),
      c.req.param("id"),
      await body(c),
    );
    return c.json({ ok: true });
  });
  app.post("/admin/users/:id/passkey-invite", async (c) =>
    c.json(await admin.passkeyInvite(ctx, c.get("caller"), c.req.param("id"))),
  );
  app.get("/admin/audit", async (c) =>
    c.json(await listAudit(ctx, c.get("caller"))),
  );

  // --- Configuration file ---------------------------------------------------------

  app.get("/admin/config", async (c) =>
    c.json(await config.exportConfig(ctx, c.get("caller"))),
  );
  app.post("/admin/config/plan", async (c) =>
    c.json(await config.planConfig(ctx, c.get("caller"), await body(c))),
  );
  app.post("/admin/config/apply", async (c) =>
    c.json(await config.applyConfig(ctx, c.get("caller"), await body(c))),
  );

  // --- Backups -----------------------------------------------------------------

  app.get("/admin/backups", async (c) => {
    requireAdmin(c.get("caller"));
    const settings = await getSettings(ctx);
    return c.json({
      /** False on targets with no disk to keep snapshots on (Cloudflare Workers). */
      automatic: Boolean(snapshots),
      everyHours: settings.backupEveryHours,
      keep: settings.backupKeep,
      snapshots: snapshots ? await snapshots() : [],
    });
  });
  app.get("/admin/backup", async (c) => {
    const caller = c.get("caller");
    requireAdmin(caller);
    await audit(ctx, caller, "backup.download", "settings", "site").execute();
    return new Response(backup.exportBackup(ctx), {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${backup.backupFilename(ctx.now())}"`,
        "cache-control": "private, no-store",
      },
    });
  });
  // Offered on the setup page: an empty installation can be started from a
  // backup instead of from nothing. Open to whoever gets there first, exactly
  // as creating the first administrator is.
  app.post("/setup/restore", async (c) => {
    if (!(await auth.isSetupNeeded(ctx))) {
      throw forbidden("This site is already set up.");
    }
    const stream = c.req.raw.body;
    if (!stream) throw badRequest("Send the backup file as the request body.");
    const counts = await backup.restoreBackup(ctx, stream);
    const caller = c.get("caller");
    await audit(
      ctx,
      caller,
      "backup.restore",
      "settings",
      "site",
      counts,
    ).execute();
    return c.json({
      restored: counts,
      origin: (await getSettings(ctx)).origin,
    });
  });

  return app;
}

export type Api = ReturnType<typeof createApi>;
