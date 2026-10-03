import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  companies,
  companyMemberships,
  heartbeatRuns,
  instanceUserRoles,
  runIdentityContexts,
} from "@paperclipai/db";
import {
  MAX_ISSUE_PREFIX_ATTEMPTS,
  deriveIssuePrefixBase,
  isIssuePrefixConflict,
  issuePrefixSuffixForAttempt,
  pickAvailableIssuePrefix,
  rekeyCompanyIssueIdentifiers,
} from "../services/issue-prefix.js";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import { agentRunWritesRevoked } from "../agent-run-cancellation.js";
import { isUuidLike, normalizeAgentApiKeyScope, type DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "./logger.js";
import { captureRunIdentity } from "../services/run-identity.js";
import { isLockNotAvailable } from "../db-errors.js";
import { boardAuthService } from "../services/board-auth.js";

/**
 * Upper bound on how long an authenticated request waits for the run-identity
 * capture lock. Kept in single-digit seconds on purpose: a fast, retryable 503
 * lets the agent back off and retry, where an open-ended wait both strands the
 * caller and pins one of the shared pool's connections for the duration.
 */
const RUN_IDENTITY_LOCK_TIMEOUT_MS = 5_000;
const RUN_IDENTITY_LOCK_RETRY_AFTER_S = 2;

const CLOUD_TENANT_WRITE_DEBOUNCE_MS = 5_000;
const CLOUD_TENANT_WRITE_DEBOUNCE_MAX = 1_000;
const cloudTenantWriteDebounces = new WeakMap<Db, Map<string, { fingerprint: string; syncedAt: number }>>();

function cloudTenantWriteDebounceFor(db: Db) {
  let debounce = cloudTenantWriteDebounces.get(db);
  if (!debounce) {
    debounce = new Map();
    cloudTenantWriteDebounces.set(db, debounce);
  }
  return debounce;
}

function pruneCloudTenantWriteDebounce(
  debounce: Map<string, { fingerprint: string; syncedAt: number }>,
  nowMs: number,
) {
  for (const [subject, entry] of debounce) {
    if (entry.syncedAt <= nowMs - CLOUD_TENANT_WRITE_DEBOUNCE_MS) debounce.delete(subject);
  }
  while (debounce.size > CLOUD_TENANT_WRITE_DEBOUNCE_MAX) {
    const oldestSubject = debounce.keys().next().value;
    if (!oldestSubject) break;
    debounce.delete(oldestSubject);
  }
}
import { instanceSettingsService } from "../services/instance-settings.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { forbidden, unauthorized, unprocessable } from "../errors.js";

export { isCloudManagedInstance } from "../services/cloud-instance.js";
import { cloudTenantPrimaryCompanyId } from "../services/cloud-instance.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeOptionalString(value: string | null | undefined) {
  return value?.trim() || null;
}

function invalidAgentTokenMessage(token: string) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    if (typeof payload.exp === "number" && payload.exp <= Math.floor(Date.now() / 1000)) {
      return "Expired agent token; obtain fresh credentials and retry";
    }
  } catch {
    // Malformed and incorrectly signed tokens share the generic failure below.
  }
  return "Agent token did not verify; obtain fresh credentials and retry";
}

async function resolveLegacyRunResponsibleUserId(
  db: Db,
  input: { companyId: string; agentId: string; runId: string },
) {
  if (!isUuidLike(input.runId)) return null;
  const run = await db
    .select({ responsibleUserId: heartbeatRuns.responsibleUserId })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
      ),
    )
    .then((rows) => rows[0] ?? null);
  return normalizeOptionalString(run?.responsibleUserId);
}

async function loadResponsibleUserMemberships(
  db: Db,
  input: { companyId: string; userId: string | null },
) {
  if (!input.userId) return [];
  const [user, memberships] = await Promise.all([
    db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.id, input.userId))
      .then((rows) => rows[0] ?? null),
    db
      .select({
        companyId: companyMemberships.companyId,
        membershipRole: companyMemberships.membershipRole,
        status: companyMemberships.status,
      })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, input.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, input.userId),
          eq(companyMemberships.status, "active"),
        ),
      ),
  ]);
  return user ? memberships : [];
}

/**
 * The user's own active company memberships — the exact company scope a
 * locally authenticated session actor carries. Shared by the session path
 * and the Cloud trusted-header path so both resolve the same access set.
 */
async function loadActiveUserCompanyMemberships(db: Db, userId: string) {
  return db
    .select({
      companyId: companyMemberships.companyId,
      membershipRole: companyMemberships.membershipRole,
      status: companyMemberships.status,
    })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
        eq(companyMemberships.status, "active"),
      ),
    );
}

async function auditAgentJwtRunHeaderMismatch(
  db: Db,
  input: { companyId: string; agentId: string; claimRunId: string; headerRunId: string; method: string; url: string },
) {
  try {
    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      action: "auth.agent_jwt_run_header_mismatch",
      entityType: "heartbeat_run",
      entityId: input.claimRunId,
      ...(isUuidLike(input.agentId) ? { agentId: input.agentId } : {}),
      ...(isUuidLike(input.claimRunId) ? { runId: input.claimRunId } : {}),
      details: {
        claimRunId: input.claimRunId,
        headerRunId: input.headerRunId,
        method: input.method,
        url: input.url,
      },
    });
  } catch (err) {
    logger.warn(
      { err, companyId: input.companyId, agentId: input.agentId, claimRunId: input.claimRunId },
      "Failed to audit rejected agent JWT run header mismatch",
    );
  }
}

async function auditAgentKeyMissingResponsibleUser(
  db: Db,
  input: { companyId: string; agentId: string; keyId: string; method: string; url: string },
) {
  try {
    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      action: "auth.agent_key_missing_responsible_user",
      entityType: "agent_api_key",
      entityId: input.keyId,
      ...(isUuidLike(input.agentId) ? { agentId: input.agentId } : {}),
      details: {
        method: input.method,
        url: input.url,
      },
    });
  } catch (err) {
    logger.warn(
      { err, companyId: input.companyId, agentId: input.agentId, keyId: input.keyId },
      "Failed to audit rejected agent key without responsible user binding",
    );
  }
}

interface ActorMiddlewareOptions {
  deploymentMode: DeploymentMode;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
}

const publicRoutineWebhookPath = /^\/api\/routine-triggers\/public\/[a-f0-9]{24}\/fire\/?$/i;

const publicMcpGatewayProtocolPath = /^\/mcp\/gateways\/gw_[a-f0-9]{32}\/?$/i;

export function actorMiddleware(db: Db, opts: ActorMiddlewareOptions): RequestHandler {
  const boardAuth = boardAuthService(db);
  return async (req, _res, next) => {
    req.actor =
      opts.deploymentMode === "local_trusted"
        ? {
            type: "board",
            userId: "local-board",
            userName: "Local Board",
            userEmail: null,
            isInstanceAdmin: true,
            source: "local_implicit",
          }
        : { type: "none", source: "none" };

    // Routine ingress authenticates its own bearer/signature. Never interpret
    // webhook credentials as agent keys or attach an ambient browser session.
    if (req.method === "POST" && publicRoutineWebhookPath.test(req.path)) {
      req.actor = { type: "none", source: "none" };
      next();
      return;
    }

    const runIdHeader = req.header("x-paperclip-run-id");

    const authHeader = req.header("authorization");
    const hasBearerCredentials = /^bearer(?:\s|$)/i.test(authHeader ?? "");

    // Public MCP gateway protocol requests carry a pcgw_* bearer that is
    // validated by the gateway service itself. Do not interpret that bearer as
    // a board key or agent JWT here: doing so rejects the MCP handshake before
    // the protocol route can verify its run-scoped credential. Keep this bypass
    // restricted to the unguessable public gateway path; all /api routes retain
    // the normal actor authentication path below.
    if (hasBearerCredentials && publicMcpGatewayProtocolPath.test(req.path)) {
      if (runIdHeader) req.actor.runId = runIdHeader;
      next();
      return;
    }

    if (!hasBearerCredentials) {
      if (opts.deploymentMode === "authenticated" && opts.resolveSession) {
        const cloudTenantActor = await resolveCloudTenantActor(db, req);
        if (cloudTenantActor) {
          req.actor = {
            ...cloudTenantActor,
            runId: runIdHeader ?? undefined,
          };
          next();
          return;
        }

        let session: BetterAuthSessionResult | null = null;
        try {
          session = await opts.resolveSession(req);
        } catch (err) {
          logger.warn(
            { err, method: req.method, url: req.originalUrl },
            "Failed to resolve auth session from request headers",
          );
        }
        if (session?.user?.id && session.session?.id) {
          const userId = session.user.id;
          const [roleRow, memberships] = await Promise.all([
            db
              .select({ id: instanceUserRoles.id })
              .from(instanceUserRoles)
              .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
              .then((rows) => rows[0] ?? null),
            loadActiveUserCompanyMemberships(db, userId),
          ]);
          req.actor = {
            type: "board",
            userId,
            sessionId: session.session.id,
            userName: session.user.name ?? null,
            userEmail: session.user.email ?? null,
            companyIds: memberships.map((row) => row.companyId),
            memberships,
            isInstanceAdmin: Boolean(roleRow),
            runId: runIdHeader ?? undefined,
            source: "session",
          };
          next();
          return;
        }
      }
      if (runIdHeader) req.actor.runId = runIdHeader;
      next();
      return;
    }

    const token = authHeader!.slice("bearer".length).trim();
    if (!token) {
      next(unauthorized("Empty bearer token; provide valid agent credentials and retry"));
      return;
    }

    const boardKey = await boardAuth.findBoardApiKeyByToken(token);
    if (boardKey) {
      const access = await boardAuth.resolveBoardAccess(boardKey.userId);
      if (access.user) {
        await boardAuth.touchBoardApiKey(boardKey.id);
        req.actor = {
          type: "board",
          userId: boardKey.userId,
          userName: access.user?.name ?? null,
          userEmail: access.user?.email ?? null,
          companyIds: access.companyIds,
          memberships: access.memberships,
          isInstanceAdmin: access.isInstanceAdmin,
          keyId: boardKey.id,
          runId: runIdHeader || undefined,
          source: "board_key",
        };
        next();
        return;
      }
    }

    const tokenHash = hashToken(token);
    const key = await db
      .select()
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
      .then((rows) => rows[0] ?? null);

    if (!key) {
      const claims = verifyLocalAgentJwt(token);
      if (!claims) {
        next(unauthorized(invalidAgentTokenMessage(token)));
        return;
      }

      const agentRecord = await db
        .select()
        .from(agents)
        .where(eq(agents.id, claims.sub))
        .then((rows) => rows[0] ?? null);

      if (!agentRecord || agentRecord.companyId !== claims.company_id) {
        next(unauthorized("Agent record is missing or belongs to another company; obtain fresh credentials and retry"));
        return;
      }

      if (agentRecord.status === "terminated") {
        next(unauthorized("Agent is terminated and cannot authenticate"));
        return;
      }
      if (agentRecord.status === "pending_approval") {
        next(unauthorized("Agent is pending approval and cannot authenticate"));
        return;
      }
      // Pause is an authorization revocation, not scheduling advice. Only the
      // board pause route cancels in-flight runs, so the plugin pause path and
      // the budget pause path leave a running row with a live 48h token; this
      // is the one choke point every request passes through, so it is where the
      // pause has to bite.
      if (agentRecord.status === "paused") {
        next(unauthorized("Agent is paused and cannot authenticate"));
        return;
      }

      const normalizedRunIdHeader = normalizeOptionalString(runIdHeader);
      if (normalizedRunIdHeader && normalizedRunIdHeader !== claims.run_id) {
        await auditAgentJwtRunHeaderMismatch(db, {
          companyId: claims.company_id,
          agentId: claims.sub,
          claimRunId: claims.run_id,
          headerRunId: normalizedRunIdHeader,
          method: req.method,
          url: req.originalUrl,
        });
        next(
          unprocessable("X-Paperclip-Run-Id does not match signed agent JWT run_id", {
            code: "agent_jwt_run_id_mismatch",
            claimRunId: claims.run_id,
            headerRunId: normalizedRunIdHeader,
          }),
        );
        return;
      }

      // `hasPendingIdentityContext` rides along on the run read the middleware
      // already performs. It is the only thing that can make
      // `captureRunIdentity` return something other than what this row already
      // says, so when it is false the locked capture below is pure cost: two
      // `FOR UPDATE` acquisitions on the run's task row and the run row, held
      // for a five-statement transaction, on a pool shared by every request.
      // Resolving identity from the row the request already holds keeps the
      // common authenticated request lock-free.
      const [identityRun] = await db.select({ activeIdentityContextId: heartbeatRuns.activeIdentityContextId,
        responsibleUserId: heartbeatRuns.responsibleUserId, status: heartbeatRuns.status, resultJson: heartbeatRuns.resultJson,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        hasPendingIdentityContext: sql`exists (
          select 1 from ${runIdentityContexts} c
          where c.run_id = "heartbeat_runs"."id" and c.status = 'pending'
        )` }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, claims.run_id), eq(heartbeatRuns.companyId, claims.company_id), eq(heartbeatRuns.agentId, claims.sub),
        ));
      if (!identityRun) {
        // The signed run id resolved to no row in this company for this agent,
        // so the token is not scoped to a live run and must not be treated as
        // one. Signing secrets are not reachable by a run that was never
        // launched, but a revoked-and-reissued run id, a restored backup, or a
        // stale adapter env var must fail here rather than inherit whatever
        // `responsible_user_id` the claim carries.
        next(unauthorized("Run for this agent token no longer exists; obtain fresh credentials and retry"));
        return;
      }
      if (agentRunWritesRevoked(identityRun)) {
        // Fail closed on reads too. A cancelled run has nothing left to read:
        // the executor is being torn down, and the residual token can live for
        // the full TTL (48h by default). Carving out GET/HEAD/OPTIONS left that
        // token with company-wide read access to every issue, document and
        // secrets listing after the run it was scoped to was already gone.
        const conversation = identityRun.contextSnapshot?.conversationMode === true;
        _res.status(403).json({ error: conversation ? "This conversation turn was cancelled" : "This run was cancelled",
          code: conversation ? "conversation_turn_cancelled" : "agent_run_cancelled" });
        return;
      }
      if (identityRun.hasPendingIdentityContext && identityRun.activeIdentityContextId && identityRun.status === "running") {
        // A steered identity is genuinely waiting to be accepted, so this is
        // the one case that has to take the lock. Bound it: a lock timeout
        // aborts this transaction without applying anything, which is exactly
        // what the agent can retry, rather than a request that parks a pooled
        // connection until the blocking transaction happens to commit.
        try {
          const captured = await captureRunIdentity(db, {
            companyId: claims.company_id,
            agentId: claims.sub,
            runId: claims.run_id,
            lockTimeoutMs: RUN_IDENTITY_LOCK_TIMEOUT_MS,
          });
          identityRun.activeIdentityContextId = captured.context?.id ?? null;
          identityRun.responsibleUserId = captured.context?.responsibleUserId ?? null;
        } catch (err) {
          if (!isLockNotAvailable(err)) throw err;
          logger.warn(
            { err, companyId: claims.company_id, agentId: claims.sub, runId: claims.run_id, method: req.method, url: req.originalUrl },
            "Run identity capture lock timed out; rejecting so the caller can retry",
          );
          _res
            .status(503)
            .setHeader("Retry-After", String(RUN_IDENTITY_LOCK_RETRY_AFTER_S));
          _res.json({
            error: "Run identity is momentarily locked; retry this request",
            code: "run_identity_lock_timeout",
            retryAfterSeconds: RUN_IDENTITY_LOCK_RETRY_AFTER_S,
          });
          return;
        }
      }
      const onBehalfOfUserId = identityRun.activeIdentityContextId
        ? identityRun.responsibleUserId
        : claims.responsible_user_id !== undefined
        ? normalizeOptionalString(claims.responsible_user_id)
        : await resolveLegacyRunResponsibleUserId(db, {
            companyId: claims.company_id,
            agentId: claims.sub,
            runId: claims.run_id,
          });
      const onBehalfOfMemberships = await loadResponsibleUserMemberships(db, {
        companyId: claims.company_id,
        userId: onBehalfOfUserId,
      });

      req.actor = {
        type: "agent",
        agentId: claims.sub,
        companyId: claims.company_id,
        keyId: undefined,
        keyScope: normalizeAgentApiKeyScope(claims.key_scope),
        runId: claims.run_id,
        onBehalfOfUserId,
        identityContextId: identityRun.activeIdentityContextId,
        onBehalfOfMemberships,
        source: "agent_jwt",
      };
      next();
      return;
    }

    await db
      .update(agentApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(agentApiKeys.id, key.id));

    const agentRecord = await db
      .select()
      .from(agents)
      .where(eq(agents.id, key.agentId))
      .then((rows) => rows[0] ?? null);

    if (!agentRecord || agentRecord.companyId !== key.companyId) {
      next(unauthorized("Agent record is missing or belongs to another company; obtain fresh credentials and retry"));
      return;
    }
    if (agentRecord.status === "terminated") {
      next(unauthorized("Agent is terminated and cannot authenticate"));
      return;
    }
    if (agentRecord.status === "pending_approval") {
      next(unauthorized("Agent is pending approval and cannot authenticate"));
      return;
    }

    const responsibleUserId = normalizeOptionalString(key.responsibleUserId);
    if (!responsibleUserId) {
      await auditAgentKeyMissingResponsibleUser(db, {
        companyId: key.companyId,
        agentId: key.agentId,
        keyId: key.id,
        method: req.method,
        url: req.originalUrl,
      });
      next(forbidden("Responsible user is unavailable for this agent key", {
        code: "RESPONSIBLE_USER_UNAVAILABLE",
      }));
      return;
    }

    req.actor = {
      type: "agent",
      agentId: key.agentId,
      companyId: key.companyId,
      keyId: key.id,
      keyScope: normalizeAgentApiKeyScope(key.scopeConfig),
      onBehalfOfUserId: responsibleUserId,
      onBehalfOfMemberships: await loadResponsibleUserMemberships(db, {
        companyId: key.companyId,
        userId: responsibleUserId,
      }),
      runId: runIdHeader || undefined,
      source: "agent_key",
    };

    next();
  };
}

/**
 * Whether the trusted-header actor being resolved should carry computed
 * instance-admin elevation: only the stack `owner` role elevates, and only
 * while `enableOwnerInstanceAdmin` is enabled. The flag is resolved through
 * the instance-settings service so the cloud managed-config overlay applies
 * (the harness can turn elevation off fleet-wide without touching tenant
 * DBs). Fails closed: a settings read error means no elevation.
 */
async function resolveOwnerInstanceAdmin(
  db: Db,
  stackRole: "owner" | "admin" | "member" | "support",
): Promise<boolean> {
  if (stackRole !== "owner") return false;
  try {
    const experimental = await instanceSettingsService(db).getExperimental();
    return experimental.enableOwnerInstanceAdmin === true;
  } catch (err) {
    logger.warn(
      { err },
      "Failed to resolve enableOwnerInstanceAdmin for cloud tenant owner; treating elevation as disabled",
    );
    return false;
  }
}

/**
 * Minimal header accessor `resolveCloudTenantActor` needs. Express `Request`
 * satisfies it directly; websocket upgrade paths adapt a raw
 * `IncomingMessage` with {@link cloudActorHeaderSourceFromHeaders} since
 * trusted-header authentication must work identically for upgrades — a
 * cloud-proxied browser has no local Better Auth session to fall back on.
 */
export interface CloudActorHeaderSource {
  header(name: string): string | undefined;
}

/** Adapts a raw header map (e.g. `IncomingMessage.headers`) to {@link CloudActorHeaderSource}. */
export function cloudActorHeaderSourceFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): CloudActorHeaderSource {
  return {
    header(name: string) {
      const value = headers[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    },
  };
}

/**
 * postgres.js codes for connection establishment timing out or for a
 * connection the server side closed out from under an in-flight query —
 * a pooled Postgres endpoint recycling or suspending
 * (observed 2026-09-03 with a managed pooler closing the socket mid-INSERT).
 * The driver reconnects transparently on the next query; only the statement
 * that was on the wire is lost.
 */
const transientDbConnectionCodes = new Set([
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
]);

/**
 * True when the error chain (drizzle wraps the driver error as `cause`)
 * carries a postgres.js transient connection code. Exported for tests.
 */
export function isTransientDbConnectionError(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && transientDbConnectionCodes.has(code)) return true;
  }
  return false;
}

/**
 * Runs `run` and retries it up to twice when it fails on a transient
 * connection error. Two replays, not one: when a pooled endpoint
 * suspends or recycles, EVERY pooled socket is dead at once, so the first
 * replay can draw another stale socket from the pool and fail identically
 * (observed 2026-09-12: retried actor resolution still surfacing
 * CONNECTION_CLOSED). The short pause gives the driver time to notice and
 * re-dial. Callers must pass an idempotent operation. Exported for tests.
 */
export async function retryOnTransientDbConnectionError<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= 2 || !isTransientDbConnectionError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/**
 * Trusted-header actor resolution with bounded transient-connection retries.
 * The tenant sync inside is idempotent end to end — every write is an
 * upsert/on-conflict/delete and the write debounce records only after the
 * whole sync succeeds — so replaying it after a dropped connection is safe,
 * and turns a golden-path authentication 500 into a served request.
 */
export async function resolveCloudTenantActor(
  db: Db,
  req: CloudActorHeaderSource,
): Promise<Express.Request["actor"] | null> {
  return retryOnTransientDbConnectionError(() => resolveCloudTenantActorOnce(db, req));
}

async function resolveCloudTenantActorOnce(
  db: Db,
  req: CloudActorHeaderSource,
): Promise<Express.Request["actor"] | null> {
  const expectedToken = process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN?.trim();
  if (!expectedToken) return null;

  const token = req.header("x-paperclip-cloud-tenant-token")?.trim();
  if (!token || !constantTimeStringEqual(token, expectedToken)) return null;

  const userId = requiredCloudHeader(req, "x-paperclip-cloud-user-id");
  const userEmail = requiredCloudHeader(req, "x-paperclip-cloud-user-email").toLowerCase();
  const stackId = requiredCloudHeader(req, "x-paperclip-cloud-stack-id");
  const stackRole = stackMembershipRole(req.header("x-paperclip-cloud-stack-role"));
  const userName = req.header("x-paperclip-cloud-user-name")?.trim() || userEmail;
  const paperclipCompanyId = req.header("x-paperclip-cloud-paperclip-company-id")?.trim();
  const paperclipCompanyName = req
    .header("x-paperclip-cloud-paperclip-company-name")
    ?.trim();
  const companyId = cloudTenantCompanyId(stackId);
  const companyName = paperclipCompanyName || humanizeCloudStackSlug(stackId);
  const now = new Date();
  const membershipRole = stackRole === "owner" || stackRole === "admin" ? "owner" : stackRole;
  const syncFingerprint = [userEmail, userName, stackId, stackRole, paperclipCompanyId ?? ""].join(":");
  const cloudTenantWriteDebounce = cloudTenantWriteDebounceFor(db);
  pruneCloudTenantWriteDebounce(cloudTenantWriteDebounce, now.getTime());
  const previousSync = cloudTenantWriteDebounce.get(userId);
  const shouldSync = previousSync?.fingerprint !== syncFingerprint
    || previousSync.syncedAt <= now.getTime() - CLOUD_TENANT_WRITE_DEBOUNCE_MS;
  let effectiveMembership: { companyId: string; membershipRole: string | null; status: string } = {
    companyId,
    membershipRole,
    status: "active",
  };

  if (shouldSync) await db
    .insert(authUsers)
    .values({
      id: userId,
      name: userName,
      email: userEmail,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: authUsers.id,
      set: {
        name: userName,
        email: userEmail,
        emailVerified: true,
        updatedAt: now,
      },
    });

  // Earlier cloud_tenant builds granted every tenant user `instance_admin`.
  // Stale rows from those deployments would still elevate this user through
  // the BetterAuth session path, board API keys, and the authorization
  // service's own instanceUserRoles lookup — so actively purge them on every
  // trusted-header authentication instead of merely no longer inserting them.
  await db
    .delete(instanceUserRoles)
    .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")));

  if (shouldSync) await insertCloudTenantCompany(db, { companyId, companyName, now });

  if (shouldSync && paperclipCompanyName) {
    await repairCloudTenantCompanyName(db, {
      companyId,
      paperclipCompanyId,
      paperclipCompanyName,
      now,
    });
  }

  // Runs after the name repair so the prefix derives from the repaired name.
  // The helper self-gates on the legacy markers, so it is a no-op once the
  // company has been repaired or was claimed by a current build.
  if (shouldSync) {
    await repairCloudTenantCompanyProvisionDefaults(db, { companyId, stackId, now });
  }

  effectiveMembership = shouldSync ? await db
    .insert(companyMemberships)
    .values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        companyMemberships.companyId,
        companyMemberships.principalType,
        companyMemberships.principalId,
      ],
      set: {
        status: "active",
        membershipRole,
        updatedAt: now,
      },
    })
    .returning()
    .then((rows) => rows[0] ?? {
      companyId,
      membershipRole,
      status: "active",
    }) : { companyId, membershipRole, status: "active" as const };

  // Without instance-admin elevation, cloud tenant users are authorized purely
  // through company-scoped permission grants — seed the same role defaults the
  // regular membership flows create.
  if (shouldSync) await ensureHumanRoleDefaultGrants(db, {
    companyId,
    principalId: userId,
    membershipRole: effectiveMembership.membershipRole ?? membershipRole,
    grantedByUserId: null,
  });
  if (shouldSync) {
    cloudTenantWriteDebounce.delete(userId);
    cloudTenantWriteDebounce.set(userId, { fingerprint: syncFingerprint, syncedAt: Date.now() });
    pruneCloudTenantWriteDebounce(cloudTenantWriteDebounce, Date.now());
  }

  // The stack's seeded company is only where Cloud provisioned this user.
  // Companies created afterwards on the instance (imports, in-app company
  // creation) attach real membership rows for the user, so union those with
  // the pinned primary — the same active-membership scope a locally
  // authenticated session actor carries. Strictly this user's own rows; the
  // membership-creating flows seed their own permission grants, so nothing
  // needs seeding per request here. A read failure degrades to the pinned
  // primary instead of blocking authentication, mirroring the fail-closed
  // owner-elevation resolution below.
  let additionalMemberships: { companyId: string; membershipRole: string | null; status: string }[] =
    [];
  try {
    additionalMemberships = (await loadActiveUserCompanyMemberships(db, userId)).filter(
      (row) => row.companyId !== companyId,
    );
  } catch (err) {
    logger.warn(
      { err, userId, stackId },
      "Failed to load cloud tenant user's company memberships; scoping actor to the stack's primary company",
    );
  }

  return {
    type: "board",
    userId,
    userName,
    userEmail,
    companyIds: [companyId, ...additionalMemberships.map((row) => row.companyId)],
    memberships: [
      {
        companyId,
        membershipRole: effectiveMembership.membershipRole ?? membershipRole,
        status: effectiveMembership.status,
      },
      ...additionalMemberships,
    ],
    // Computed per request, never persisted: the stack owner is elevated to
    // instance admin of their own dedicated instance only while the
    // `enableOwnerInstanceAdmin` flag is on. Non-owner stack roles stay
    // company-scoped. Turning the flag off de-elevates on the next request —
    // there is no role row to clean up.
    isInstanceAdmin: await resolveOwnerInstanceAdmin(db, stackRole),
    source: "cloud_tenant",
  };
}

function requiredCloudHeader(req: CloudActorHeaderSource, name: string): string {
  const value = req.header(name)?.trim();
  if (!value) {
    throw new Error(`Missing trusted Cloud tenant header ${name}`);
  }
  return value;
}

function stackMembershipRole(value: string | undefined): "owner" | "admin" | "member" | "support" {
  if (value === "owner" || value === "admin" || value === "member" || value === "support") {
    return value;
  }
  throw new Error("Invalid trusted Cloud tenant stack role");
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function cloudTenantCompanyId(stackId: string): string {
  return cloudTenantPrimaryCompanyId(stackId);
}

export function humanizeCloudStackSlug(stackId: string): string {
  const slug = stackId
    .trim()
    .replace(/^paperclip-stack-/i, "")
    .replace(/^stack-/i, "");
  const displayName = slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
  return displayName || "Workspace";
}

export function isKnownBadCloudCompanyName(
  name: string,
  ids: { companyId: string; paperclipCompanyId?: string },
): boolean {
  const normalized = name.trim();
  return (
    /^paperclip-stack-.+/i.test(normalized) ||
    /^stack-.+\s+paperclip$/i.test(normalized) ||
    normalized === ids.companyId ||
    (ids.paperclipCompanyId !== undefined &&
      normalized === ids.paperclipCompanyId)
  );
}

async function repairCloudTenantCompanyName(
  db: Db,
  input: {
    companyId: string;
    paperclipCompanyId?: string;
    paperclipCompanyName: string;
    now: Date;
  },
): Promise<void> {
  try {
    const existing = await db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .then((rows) => rows[0]);
    if (
      !existing ||
      !isKnownBadCloudCompanyName(existing.name, {
        companyId: input.companyId,
        paperclipCompanyId: input.paperclipCompanyId,
      })
    ) {
      return;
    }
    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(companies)
        .set({ name: input.paperclipCompanyName, updatedAt: input.now })
        .where(
          and(
            eq(companies.id, input.companyId),
            // A user may rename the company between the read above and this
            // repair. Match the exact observed machine name so that concurrent
            // genuine renames always win.
            eq(companies.name, existing.name),
          ),
        )
        .returning({ id: companies.id });
      if (!updated) return;

      await tx.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "system",
        actorId: "cloud-tenant-auth",
        action: "company.updated",
        entityType: "company",
        entityId: input.companyId,
        details: {
          source: "cloud_tenant_auth",
          reason: "legacy_machine_name_repair",
          previousName: existing.name,
          name: input.paperclipCompanyName,
        },
      });
    });
  } catch (err) {
    logger.warn(
      { err, companyId: input.companyId },
      "Failed to repair legacy Cloud tenant company name",
    );
  }
}

/**
 * Claims the tenant company row for this stack.
 *
 * The prefix derives from the company name, exactly as it does for a
 * self-hosted company. Each attempt is a standalone INSERT, so a failed
 * attempt is its own implicit transaction and cannot poison a surrounding
 * one. `onConflictDoNothing` only absorbs the `companies.id` conflict — a
 * prefix that another company already holds still raises `23505`, so the loop
 * moves on to the next suffix.
 */
async function insertCloudTenantCompany(
  db: Db,
  input: { companyId: string; companyName: string; now: Date },
): Promise<void> {
  const base = deriveIssuePrefixBase(input.companyName);
  for (let attempt = 1; attempt <= MAX_ISSUE_PREFIX_ATTEMPTS; attempt += 1) {
    try {
      await db
        .insert(companies)
        .values({
          id: input.companyId,
          name: input.companyName,
          description: null,
          status: "active",
          issuePrefix: `${base}${issuePrefixSuffixForAttempt(attempt)}`,
          updatedAt: input.now,
        })
        .onConflictDoNothing({
          target: companies.id,
        });
      return;
    } catch (error) {
      if (!isIssuePrefixConflict(error)) throw error;
    }
  }
  throw new Error("Unable to allocate a unique issue prefix for the tenant company");
}

/**
 * The issue prefix that pre-name-derivation builds gave a tenant company.
 *
 * This derivation survives only as the detector for the one-time repair
 * below. Nothing mints a prefix this way any more.
 */
function legacyProvisionedIssuePrefix(stackId: string): string {
  const hash = createHash("sha256").update(stackId).digest("hex").slice(0, 4).toUpperCase();
  return `PC${hash}`;
}

/** The placeholder description that pre-name-derivation builds wrote. */
const LEGACY_PROVISIONED_DESCRIPTION_PREFIX = "Provisioned by Paperclip Cloud for stack ";

/**
 * One-time repair for companies claimed by a pre-name-derivation build.
 *
 * Those companies carry an opaque hash prefix and a placeholder description
 * that the operator never chose. Re-derive the prefix from the company's
 * current name, re-key the stored issue and case identifiers onto it, and drop
 * the placeholder. Both guards stop matching once the repair lands, so a later
 * pass is a no-op.
 */
async function repairCloudTenantCompanyProvisionDefaults(
  db: Db,
  input: { companyId: string; stackId: string; now: Date },
): Promise<void> {
  try {
    const existing = await db
      .select({
        name: companies.name,
        issuePrefix: companies.issuePrefix,
        description: companies.description,
      })
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .then((rows) => rows[0]);
    if (!existing) return;

    const legacyPrefix = legacyProvisionedIssuePrefix(input.stackId);
    const legacyDescription = existing.description?.startsWith(LEGACY_PROVISIONED_DESCRIPTION_PREFIX)
      ? existing.description
      : null;
    if (existing.issuePrefix !== legacyPrefix) {
      if (!legacyDescription) return;
      // The prefix was already re-derived, so only the placeholder is left.
      await db
        .update(companies)
        .set({ description: null, updatedAt: input.now })
        .where(and(
          eq(companies.id, input.companyId),
          eq(companies.description, legacyDescription),
        ));
      return;
    }

    await db.transaction(async (tx) => {
      const candidate = await pickAvailableIssuePrefix(tx, deriveIssuePrefixBase(existing.name));
      if (!candidate || candidate === legacyPrefix) return;

      const [updated] = await tx
        .update(companies)
        .set({
          issuePrefix: candidate,
          ...(legacyDescription ? { description: null } : {}),
          updatedAt: input.now,
        })
        .where(and(
          eq(companies.id, input.companyId),
          // A user may rename the company between the read above and this
          // repair. Match the exact observed legacy prefix so that concurrent
          // genuine renames always win.
          eq(companies.issuePrefix, legacyPrefix),
        ))
        .returning({ id: companies.id });
      if (!updated) return;

      const rekeyed = await rekeyCompanyIssueIdentifiers(tx, {
        companyId: input.companyId,
        fromPrefix: legacyPrefix,
        toPrefix: candidate,
      });

      await tx.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "system",
        actorId: "cloud-tenant-auth",
        action: "company.updated",
        entityType: "company",
        entityId: input.companyId,
        details: {
          source: "cloud_tenant_auth",
          reason: "legacy_provision_defaults_repair",
          previousIssuePrefix: legacyPrefix,
          issuePrefix: candidate,
          descriptionCleared: legacyDescription !== null,
          issuesRekeyed: rekeyed.issues,
          casesRekeyed: rekeyed.cases,
        },
      });
    });
  } catch (err) {
    logger.warn(
      { err, companyId: input.companyId },
      "Failed to repair legacy tenant company provisioning defaults",
    );
  }
}

export function requireBoard(req: Express.Request) {
  return req.actor.type === "board";
}
