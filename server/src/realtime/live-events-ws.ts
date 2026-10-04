import { createHash } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, agents, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { isAgentStatusInvokable, normalizeAgentApiKeyScope, type DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "../middleware/logger.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";

interface WsSocket {
  readyState: number;
  ping(): void;
  send(data: string): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
  on(event: "pong", listener: () => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

interface WsServer {
  clients: Set<WsSocket>;
  on(event: "connection", listener: (socket: WsSocket, req: IncomingMessage) => void): void;
  on(event: "close", listener: () => void): void;
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: WsSocket) => void,
  ): void;
  emit(event: "connection", ws: WsSocket, req: IncomingMessage): boolean;
}

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws") as {
  WebSocket: { OPEN: number };
  WebSocketServer: new (opts: { noServer: boolean }) => WsServer;
};

interface UpgradeContext {
  companyId: string;
  actorType: "board" | "agent";
  actorId: string;
  /** Set for agent-key actors only, so revocation can be re-checked per socket. */
  keyId?: string;
}

/** Cloud-proxied browser identity resolved from trusted x-paperclip-cloud-* headers. */
export interface CloudUpgradeActor {
  userId: string;
  /** Companies this actor may subscribe to (primary stack company + real memberships). */
  companyIds: string[];
}

interface IncomingMessageWithContext extends IncomingMessage {
  paperclipWebSocketHandled?: boolean;
  paperclipUpgradeContext?: UpgradeContext;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function isWritableUpgradeSocket(socket: Duplex) {
  const maybeWritableState = socket as Duplex & { writable?: boolean; writableEnded?: boolean; writableDestroyed?: boolean };
  return !socket.destroyed && maybeWritableState.writable !== false && !maybeWritableState.writableEnded && !maybeWritableState.writableDestroyed;
}

function closeUpgradeSocket(socket: Duplex) {
  if (!socket.destroyed) {
    socket.destroy();
  }
}

function rejectUpgrade(socket: Duplex, statusLine: string, message: string) {
  const safe = message.replace(/[\r\n]+/g, " ").trim();
  if (!isWritableUpgradeSocket(socket)) {
    closeUpgradeSocket(socket);
    return;
  }

  try {
    socket.once("finish", () => closeUpgradeSocket(socket));
    socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${safe}`);
  } catch (err) {
    logger.warn({ err }, "failed to reject live websocket upgrade");
    closeUpgradeSocket(socket);
  }
}

function parseCompanyId(pathname: string) {
  const match = pathname.match(/^\/api\/companies\/([^/]+)\/events\/ws$/);
  if (!match) return null;

  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return null;
  }
}

function parseBearerToken(rawAuth: string | string[] | undefined) {
  const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
  if (!auth) return null;
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice("bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function headersFromIncomingMessage(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(req.headers)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

async function authorizeUpgrade(
  db: Db,
  req: IncomingMessage,
  companyId: string,
  url: URL,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
    resolveCloudActor?: (req: IncomingMessage) => Promise<CloudUpgradeActor | null>;
  },
): Promise<UpgradeContext | null> {
  const queryToken = url.searchParams.get("token")?.trim() ?? "";
  const authToken = parseBearerToken(req.headers.authorization);
  const token = authToken ?? (queryToken.length > 0 ? queryToken : null);

  // Browser board context has no bearer token in local_trusted and authenticated modes.
  if (!token) {
    if (opts.deploymentMode === "local_trusted") {
      return {
        companyId,
        actorType: "board",
        actorId: "board",
      };
    }

    // Cloud-managed deployments authenticate proxied browsers with trusted
    // x-paperclip-cloud-* headers, never a local Better Auth session — the
    // session fallback below can only 403 them, which left the live-events
    // socket permanently unreachable behind the Cloud front door. A resolved
    // cloud actor is authoritative: authorize against its membership scope.
    // Absent/invalid cloud headers fall through to the session path, so
    // self-hosted behavior is unchanged.
    if (opts.resolveCloudActor) {
      const cloudActor = await opts.resolveCloudActor(req);
      if (cloudActor) {
        if (!cloudActor.companyIds.includes(companyId)) return null;
        return {
          companyId,
          actorType: "board",
          actorId: cloudActor.userId,
        };
      }
    }

    if (opts.deploymentMode !== "authenticated" || !opts.resolveSessionFromHeaders) {
      return null;
    }

    const session = await opts.resolveSessionFromHeaders(headersFromIncomingMessage(req));
    const userId = session?.user?.id;
    if (!userId) return null;

    const [roleRow, memberships] = await Promise.all([
      db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows[0] ?? null),
      db
        .select({ companyId: companyMemberships.companyId })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        ),
    ]);

    const hasCompanyMembership = memberships.some((row) => row.companyId === companyId);
    if (!roleRow && !hasCompanyMembership) return null;

    return {
      companyId,
      actorType: "board",
      actorId: userId,
    };
  }

  const tokenHash = hashToken(token);
  const key = await db
    .select()
    .from(agentApiKeys)
    .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
    .then((rows) => rows[0] ?? null);

  if (!key || key.companyId !== companyId) {
    return null;
  }

  // Narrowed scopes are the platform's low-trust key tier: `skill_test` is
  // pinned to one issue, `task_bridge` to a project/parent-issue boundary, and
  // both are enforced centrally on HTTP (services/authorization.ts branches on
  // actor.keyScope). This socket subscribes to the whole company event stream
  // with no per-event filtering, so a narrowed key that got through here would
  // receive company-wide assistant text, activity payloads and goal projections
  // — the exact data its sandbox exists to withhold. There is no consistent
  // world in which such a key is confined over HTTP and not over a socket, and
  // no shipped consumer needs it: every WS client today connects with a board
  // session. Refuse narrowed scopes here rather than re-implementing scope
  // decisions inside the subscriber.
  const keyScope = normalizeAgentApiKeyScope(key.scopeConfig);
  if (keyScope.kind !== "standard") {
    logger.warn(
      { companyId, agentId: key.agentId, scope: keyScope.kind },
      "rejected live websocket upgrade for a narrowed-scope agent key",
    );
    return null;
  }

  // An `agentApiKeys` row is not self-revoking, and this upgrade handler is a
  // raw `server.on("upgrade")` listener — it never reaches Express or
  // `actorMiddleware`, so the middleware's status checks cannot cover it. Without
  // this read, a paused (or pending-approval, or terminated-but-not-yet-swept)
  // agent's stored key opens a socket and gets subscribed to the whole company
  // event stream for the life of the connection. Same fail-closed predicate as
  // the middleware; terminate's revokedAt sweep is a second line of defence for
  // the terminated case, not the only one.
  const agentRecord = await db
    .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
    .from(agents)
    .where(eq(agents.id, key.agentId))
    .then((rows) => rows[0] ?? null);

  if (!agentRecord || agentRecord.companyId !== key.companyId) {
    return null;
  }

  if (!isAgentStatusInvokable(agentRecord.status)) {
    logger.warn(
      { companyId, agentId: key.agentId, status: agentRecord.status },
      "rejected live websocket upgrade for a non-invokable agent",
    );
    return null;
  }

  await db
    .update(agentApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(agentApiKeys.id, key.id));

  return {
    companyId,
    actorType: "agent",
    actorId: key.agentId,
    keyId: key.id,
  };
}

export function setupLiveEventsWebSocketServer(
  server: HttpServer,
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
    /**
     * Resolves a Cloud-proxied browser's identity from the trusted
     * x-paperclip-cloud-* headers on the upgrade request. Wired by managed
     * deployments; self-hosted instances leave it unset.
     */
    resolveCloudActor?: (req: IncomingMessage) => Promise<CloudUpgradeActor | null>;
  },
) {
  const wss = new WebSocketServer({ noServer: true });
  const cleanupByClient = new Map<WsSocket, () => void>();
  const aliveByClient = new Map<WsSocket, boolean>();
  // Agent-key sockets only. A board actor is governed by its session; an agent
  // key has no expiry and no run row, so the only thing that can take a live
  // subscription away is a status change we re-read ourselves.
  const agentIdByClient = new Map<WsSocket, string>();
  const keyIdByClient = new Map<WsSocket, string>();

  /**
   * Closes sockets whose authorization no longer holds. Two independent reasons,
   * and the second matters more than the pause case:
   *
   * - The agent stopped being invokable (paused, terminated, deleted). Bounded
   *   by this interval, and acceptable: pause does not revoke the key, so during
   *   the residual window the credential is still entitled to the same
   *   company-scoped data it could fetch over HTTP anyway.
   * - **The key was revoked.** `revokeKey` stamps `revokedAt` and touches
   *   nothing else — it does not pause or terminate the agent — so the status
   *   read alone would see a healthy agent and let the socket stream company
   *   events indefinitely. Revoking a key is the incident-response action for a
   *   suspected credential compromise, and a revoked credential must not keep
   *   live read access. That one is unbounded without this check.
   *
   * The alternative for the status half is an event-driven close wired into
   * every pause writer, and there are five of those, three of which write
   * `agents.status` in raw SQL — a missed hook there fails silently and
   * permanently. A missed tick is bounded and self-heals on the next one.
   */
  let revalidateInFlight = false;
  const revalidateAgentSockets = async () => {
    if (revalidateInFlight) return;
    const agentIds = [...new Set(agentIdByClient.values())];
    const keyIds = [...new Set(keyIdByClient.values())];
    if (agentIds.length === 0 && keyIds.length === 0) return;

    revalidateInFlight = true;
    try {
      const agentRows = agentIds.length
        ? await db
            .select({ id: agents.id, status: agents.status })
            .from(agents)
            .where(inArray(agents.id, agentIds))
        : [];
      const keyRows = keyIds.length
        ? await db
            .select({ id: agentApiKeys.id, revokedAt: agentApiKeys.revokedAt })
            .from(agentApiKeys)
            .where(inArray(agentApiKeys.id, keyIds))
        : [];

      const statusByAgentId = new Map(agentRows.map((row) => [row.id, row.status]));
      const revokedAtByKeyId = new Map(keyRows.map((row) => [row.id, row.revokedAt]));

      for (const [socket, agentId] of [...agentIdByClient]) {
        const keyId = keyIdByClient.get(socket);
        const status = statusByAgentId.get(agentId);

        const statusOk = status !== undefined && isAgentStatusInvokable(status);

        // `has` before `get`: an unrevoked key carries revokedAt === null, which
        // a bare `get(id) ?? fallback` would read as "no row". A key missing from
        // the table failed the same way a revoked one does — the credential
        // behind this socket no longer exists.
        const keyRowPresent = keyId !== undefined && revokedAtByKeyId.has(keyId);
        const keyRevoked = keyRowPresent && revokedAtByKeyId.get(keyId) != null;
        const keyOk = keyRowPresent && !keyRevoked;
        if (statusOk && keyOk) continue;

        agentIdByClient.delete(socket);
        keyIdByClient.delete(socket);
        logger.warn(
          {
            agentId,
            keyId: keyId ?? null,
            status: status ?? null,
            keyRevoked,
            keyMissing: keyId !== undefined && !keyRowPresent,
          },
          "closing live websocket for an agent or credential that is no longer authorized",
        );
        try {
          socket.close(1008, "agent no longer authorized");
        } catch (err) {
          logger.warn({ err, agentId }, "failed to close live websocket for a non-invokable agent");
          socket.terminate();
        }
      }
    } catch (err) {
      // Never tear sockets down on a failed read: a transient database error
      // must not become a self-inflicted disconnect storm.
      logger.warn({ err }, "live websocket agent revalidation failed");
    } finally {
      revalidateInFlight = false;
    }
  };

  const pingInterval = setInterval(() => {
    for (const socket of wss.clients) {
      if (!aliveByClient.get(socket)) {
        socket.terminate();
        continue;
      }
      aliveByClient.set(socket, false);
      socket.ping();
    }
    void revalidateAgentSockets();
  }, 30000);

  wss.on("connection", (socket: WsSocket, req: IncomingMessage) => {
    const context = (req as IncomingMessageWithContext).paperclipUpgradeContext;
    if (!context) {
      socket.close(1008, "missing context");
      return;
    }

    const unsubscribe = subscribeCompanyLiveEvents(context.companyId, (event) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(event));
    });

    cleanupByClient.set(socket, unsubscribe);
    aliveByClient.set(socket, true);
    if (context.actorType === "agent") {
      agentIdByClient.set(socket, context.actorId);
      if (context.keyId) {
        keyIdByClient.set(socket, context.keyId);
      }
    }

    socket.on("pong", () => {
      aliveByClient.set(socket, true);
    });

    socket.on("close", () => {
      const cleanup = cleanupByClient.get(socket);
      if (cleanup) cleanup();
      cleanupByClient.delete(socket);
      aliveByClient.delete(socket);
      agentIdByClient.delete(socket);
      keyIdByClient.delete(socket);
    });

    socket.on("error", (err: Error) => {
      logger.warn({ err, companyId: context.companyId }, "live websocket client error");
    });
  });

  wss.on("close", () => {
    clearInterval(pingInterval);
  });

  server.on("upgrade", (req, socket, head) => {
    if ((req as IncomingMessageWithContext).paperclipWebSocketHandled) {
      return;
    }

    const onRawSocketError = (err: Error) => {
      logger.warn({ err, path: req.url }, "live websocket upgrade socket error");
    };
    const cleanupRawSocketListeners = () => {
      socket.off("error", onRawSocketError);
      socket.off("close", cleanupRawSocketListeners);
    };

    socket.on("error", onRawSocketError);
    socket.once("close", cleanupRawSocketListeners);

    if (!req.url) {
      rejectUpgrade(socket, "400 Bad Request", "missing url");
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const companyId = parseCompanyId(url.pathname);
    if (!companyId) {
      closeUpgradeSocket(socket);
      return;
    }

    void authorizeUpgrade(db, req, companyId, url, {
      deploymentMode: opts.deploymentMode,
      resolveSessionFromHeaders: opts.resolveSessionFromHeaders,
      resolveCloudActor: opts.resolveCloudActor,
    })
      .then((context) => {
        if (!context) {
          rejectUpgrade(socket, "403 Forbidden", "forbidden");
          return;
        }

        if (!isWritableUpgradeSocket(socket)) {
          cleanupRawSocketListeners();
          return;
        }

        const reqWithContext = req as IncomingMessageWithContext;
        reqWithContext.paperclipUpgradeContext = context;

        cleanupRawSocketListeners();
        wss.handleUpgrade(req, socket, head, (ws: WsSocket) => {
          wss.emit("connection", ws, reqWithContext);
        });
      })
      .catch((err) => {
        logger.error({ err, path: req.url }, "failed websocket upgrade authorization");
        rejectUpgrade(socket, "500 Internal Server Error", "upgrade failed");
      });
  });

  return wss;
}
