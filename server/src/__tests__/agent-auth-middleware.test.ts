import { createHash, createHmac, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  boardApiKeys,
  heartbeatRuns,
} from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { assertCompanyAccess } from "../routes/authz.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createSelectChain(rowsForTable: (table: unknown) => unknown[]) {
  return {
    from(table: unknown) {
      return {
        where() {
          return Promise.resolve(rowsForTable(table));
        },
      };
    },
  };
}

function createDbState(input: {
  agent: { id: string; companyId: string; status?: string };
  agentKey?: { id: string; agentId: string; companyId: string; keyHash: string; responsibleUserId?: string | null };
  run?: { id: string; companyId: string; agentId: string; responsibleUserId?: string | null;
    status?: string; contextSnapshot?: Record<string, unknown>; resultJson?: Record<string, unknown> };
}) {
  const activity: Array<Record<string, unknown>> = [];
  const agentRow = {
    id: input.agent.id,
    companyId: input.agent.companyId,
    status: input.agent.status ?? "active",
  };
  const keyRow = input.agentKey
    ? {
        id: input.agentKey.id,
        agentId: input.agentKey.agentId,
        companyId: input.agentKey.companyId,
        keyHash: input.agentKey.keyHash,
        responsibleUserId: input.agentKey.responsibleUserId ?? null,
        revokedAt: null,
        scopeConfig: null,
      }
    : null;
  const runRow = input.run
    ? {
        id: input.run.id,
        companyId: input.run.companyId,
        agentId: input.run.agentId,
        responsibleUserId: input.run.responsibleUserId ?? null,
        status: input.run.status ?? "running",
        contextSnapshot: input.run.contextSnapshot ?? {},
        resultJson: input.run.resultJson ?? {},
      }
    : null;

  const db = {
    select: () =>
      createSelectChain((table) => {
        if (table === boardApiKeys) return [];
        if (table === agentApiKeys) return keyRow ? [keyRow] : [];
        if (table === agents) return [agentRow];
        if (table === heartbeatRuns) return runRow ? [runRow] : [];
        return [];
      }),
    update: () => ({
      set() {
        return {
          where() {
            return Promise.resolve([]);
          },
        };
      },
    }),
    insert: (table: unknown) => ({
      values(values: Record<string, unknown>) {
        if (table === activityLog) activity.push(values);
        return Promise.resolve([]);
      },
    }),
  } as any;

  return { db, activity, agentRow, keyRow };
}

function createApp(db: any, deploymentMode: "authenticated" | "local_trusted" = "authenticated") {
  const app = express();
  app.use(express.json());
  app.use(
    actorMiddleware(db, {
      deploymentMode,
      resolveSession: async () => null,
    }),
  );
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  app.post("/api/routine-triggers/public/:publicId/fire", (req, res) => {
    res.json({ reachedWebhook: true, actorType: req.actor.type });
  });
  app.post("/mcp/gateways/:gatewayPublicId", (req, res) => {
    res.json({ reachedGatewayProtocol: true, actorType: req.actor.type });
  });
  app.get("/companies/:companyId/protected", (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json({ ok: true });
  });
  app.get("/companies/:companyId/issues/:issueId", (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json({ id: req.params.issueId, readable: true });
  });
  app.patch("/companies/:companyId/issues/:issueId", (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json({ id: req.params.issueId, writable: true });
  });
  app.use(errorHandler);
  return app;
}

function craftAgentJwtWithoutResponsibleClaim(input: {
  secret: string;
  agentId: string;
  companyId: string;
  adapterType: string;
  runId: string;
  expiresInSeconds?: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const claims = {
    sub: input.agentId,
    company_id: input.companyId,
    adapter_type: input.adapterType,
    run_id: input.runId,
    iat: now,
    exp: now + (input.expiresInSeconds ?? 3600),
    iss: "paperclip",
    aud: "paperclip-api",
  };
  const headerB64 = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
  const claimsB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signingInput = `${headerB64}.${claimsB64}`;
  // Sign with the same per-instance, per-company key the server derives. The
  // instance defaults to "default" (beforeEach clears PAPERCLIP_INSTANCE_ID),
  // matching the live control plane this middleware test exercises. This helper
  // only omits the responsible_user_id claim — it is not a cross-instance token.
  const signingKey = createHmac("sha256", input.secret).update(`jwt:default:${input.companyId}`).digest("hex");
  const signature = createHmac("sha256", signingKey).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

describe("agent auth middleware", () => {
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const originalTtl = process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
  const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "auth-middleware-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "3600";
    // Pin the control-plane instance so mint/verify (and the hand-crafted
    // legacy token helper) all derive keys under the "default" live instance.
    delete process.env.PAPERCLIP_INSTANCE_ID;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
    if (originalTtl === undefined) delete process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
    else process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = originalTtl;
    if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
  });

  it.each([
    { status: "cancelled", conversationMode: false, requested: false },
    { status: "running", conversationMode: false, requested: true },
    { status: "cancelled", conversationMode: true, requested: false },
    { status: "running", conversationMode: true, requested: true },
  ])("revokes reads and writes for a stopped run: %j", async ({ status, conversationMode, requested }) => {
    const agentId = randomUUID();
    const companyId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({ agent: { id: agentId, companyId }, run: {
      id: runId, companyId, agentId, status, contextSnapshot: { conversationMode },
      resultJson: requested ? { executionCancellation: { state: "requested" } } : {},
    } });
    const token = createLocalAgentJwt(agentId, companyId, "grok_local", runId, null);
    const client = createApp(db);
    const endpoint = `/companies/${companyId}/issues/${randomUUID()}`;
    const expectedCode = conversationMode ? "conversation_turn_cancelled" : "agent_run_cancelled";
    const write = await request(client).patch(endpoint).set("Authorization", `Bearer ${token}`).send({ status: "done" });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe(expectedCode);
    // A stopped run has nothing left to read, and its token can live for the
    // full 48h TTL. Reads must not stay open behind that.
    const read = await request(client).get(endpoint).set("Authorization", `Bearer ${token}`);
    expect(read.status).toBe(403);
    expect(read.body.code).toBe(expectedCode);
    expect(read.body.readable).toBeUndefined();
  });

  it("rejects a run JWT whose run row no longer matches", async () => {
    const agentId = randomUUID();
    const companyId = randomUUID();
    const runId = randomUUID();
    // No `run` at all: the signed run id resolves to nothing for this agent.
    const { db } = createDbState({ agent: { id: agentId, companyId } });
    const token = createLocalAgentJwt(agentId, companyId, "grok_local", runId, "user-claim");

    const read = await request(createApp(db))
      .get(`/companies/${companyId}/issues/${randomUUID()}`)
      .set("Authorization", `Bearer ${token}`);
    const write = await request(createApp(db))
      .patch(`/companies/${companyId}/issues/${randomUUID()}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "done" });

    expect(read.status).toBe(401);
    expect(write.status).toBe(401);
    expect(read.body.error).toContain("no longer exists");
  });

  it("rejects a run JWT for a paused agent before it reaches any resource", async () => {
    const agentId = randomUUID();
    const companyId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId, status: "paused" },
      run: { id: runId, companyId, agentId, status: "running" },
    });
    const token = createLocalAgentJwt(agentId, companyId, "grok_local", runId, "user-claim");
    const client = createApp(db);

    // Pause is revocation, not scheduling advice: an in-flight run row can stay
    // `running` (the plugin and budget pause paths never cancel runs), and the
    // token outlives the pause by its full TTL.
    const read = await request(client)
      .get(`/companies/${companyId}/issues/${randomUUID()}`)
      .set("Authorization", `Bearer ${token}`);
    const write = await request(client)
      .patch(`/companies/${companyId}/issues/${randomUUID()}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "done" });

    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(read.body.code).toBe("agent_paused");
    expect(read.body.error).toContain("paused");
    // Not a 401: the CLI arms board-auth recovery on any 401 and replays the
    // request with board credentials, so the run-JWT branch has to deny the same
    // way the stored-key branch does. 160 lines apart in one function is exactly
    // how the two drifted in the first place.
    expect(read.body.error).not.toContain("Board access required");
    expect(read.body.error).not.toContain("Instance admin required");
  });

  // `agents.status` is a plain text column: no DB enum, no check constraint. A
  // deny-list of the three named statuses is complete only for today's enum, so
  // both branches fail closed on anything outside the invokable set.
  it("rejects a stored agent key for an agent in an unknown status", async () => {
    const agentId = randomUUID();
    const companyId = randomUUID();
    const token = "pcp_test_agent_key_unknown_status";
    const { db } = createDbState({
      agent: { id: agentId, companyId, status: "hibernating" },
      agentKey: {
        id: randomUUID(),
        agentId,
        companyId,
        keyHash: hashToken(token),
        responsibleUserId: "user-key",
      },
    });

    const res = await request(createApp(db))
      .get(`/companies/${companyId}/issues/${randomUUID()}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("agent_not_invokable");
    // The raw column value must not be echoed back into the response body.
    expect(res.body.error).not.toContain("hibernating");
  });

  it("rejects a run JWT for an agent in an unknown status", async () => {
    const agentId = randomUUID();
    const companyId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId, status: "hibernating" },
      run: { id: runId, companyId, agentId, status: "running" },
    });
    const token = createLocalAgentJwt(agentId, companyId, "grok_local", runId, "user-claim");

    const res = await request(createApp(db))
      .get(`/companies/${companyId}/issues/${randomUUID()}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("agent_not_invokable");
    expect(res.body.error).not.toContain("hibernating");
  });

  it("keeps header-less local requests as the implicit board actor with their run id", async () => {
    const runId = randomUUID();
    const { db } = createDbState({ agent: { id: randomUUID(), companyId: randomUUID() } });

    const res = await request(createApp(db, "local_trusted"))
      .get("/actor")
      .set("X-Paperclip-Run-Id", runId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "board", userId: "local-board", runId });
  });

  it.each([
    ["empty bearer token", "Bearer   ", "Empty bearer token"],
    ["unverified token", "Bearer not-a-token", "Agent token did not verify"],
  ])("rejects %s instead of retaining the implicit local-board actor", async (_label, authorization, error) => {
    const { db } = createDbState({ agent: { id: randomUUID(), companyId: randomUUID() } });
    let commentWrites = 0;
    const app = createApp(db, "local_trusted");
    app.post("/comments", (_req, res) => {
      commentWrites += 1;
      res.status(201).json({ ok: true });
    });

    const res = await request(app).post("/comments").set("Authorization", authorization).send({ body: "reply" });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain(error);
    expect(commentWrites).toBe(0);
  });

  it.each(["authenticated", "local_trusted"] as const)(
    "leaves webhook authentication to the trigger in %s mode",
    async (deploymentMode) => {
      const { db } = createDbState({ agent: { id: randomUUID(), companyId: randomUUID() } });
      const res = await request(createApp(db, deploymentMode))
        .post(`/api/routine-triggers/public/${"a".repeat(24)}/fire`)
        .set("Authorization", "Bearer routine-secret")
        .send({ event: "created" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ reachedWebhook: true, actorType: "none" });
    },
  );

  it.each([
    `/api/routine-triggers/public/${"a".repeat(24)}/rotate-secret`,
    "/api/routine-triggers/public/not-a-public-id/fire",
    `/api/routine-triggers/public/${"a".repeat(24)}/fire/extra`,
  ])("does not bypass actor authentication for %s", async (path) => {
    const { db } = createDbState({ agent: { id: randomUUID(), companyId: randomUUID() } });
    const res = await request(createApp(db)).post(path).set("Authorization", "Bearer routine-secret");
    expect(res.status).toBe(401);
  });

  it("leaves public MCP gateway bearers for the gateway protocol to validate", async () => {
    const { db } = createDbState({ agent: { id: randomUUID(), companyId: randomUUID() } });
    const publicId = `gw_${"a".repeat(32)}`;

    const res = await request(createApp(db, "local_trusted"))
      .post(`/mcp/gateways/${publicId}`)
      .set("Authorization", "Bearer pcgw_runtime_token")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reachedGatewayProtocol: true });
  });

  it("does not bypass actor authentication for lookalike MCP gateway paths", async () => {
    const { db } = createDbState({ agent: { id: randomUUID(), companyId: randomUUID() } });

    const res = await request(createApp(db, "local_trusted"))
      .post("/mcp/gateways/not-a-public-id")
      .set("Authorization", "Bearer pcgw_runtime_token")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Agent token did not verify");
  });

  it.each([
    ["terminated", "Agent is terminated"],
    ["pending_approval", "Agent is pending approval"],
  ])("rejects a %s agent JWT instead of retaining local-board", async (status, error) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({ agent: { id: agentId, companyId, status } });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-1");

    const res = await request(createApp(db, "local_trusted"))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain(error);
  });

  it("rejects an agent JWT when the agent record belongs to another company", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({ agent: { id: agentId, companyId: randomUUID() } });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-1");

    const res = await request(createApp(db, "local_trusted"))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("missing or belongs to another company");
  });

  it("reports an expired agent JWT specifically", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({ agent: { id: agentId, companyId } });
    const token = craftAgentJwtWithoutResponsibleClaim({
      secret: process.env.PAPERCLIP_AGENT_JWT_SECRET!,
      agentId,
      companyId,
      adapterType: "codex_local",
      runId,
      expiresInSeconds: -1,
    });

    const res = await request(createApp(db, "local_trusted"))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Expired agent token");
  });

  it("uses the signed responsible_user_id claim and keeps the signed run id authoritative", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-row" },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim");

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId,
      companyId,
      runId,
      onBehalfOfUserId: "user-claim",
      source: "agent_jwt",
    });
  });

  it("preserves signed skill_test JWT scope on the request actor", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-claim" },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim", {
      kind: "skill_test",
      issueId,
    });

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId,
      companyId,
      keyScope: { kind: "skill_test", issueId },
      source: "agent_jwt",
    });
  });

  it("rejects mismatched run headers for agent JWTs and audits the spoof attempt", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const spoofedRunId = randomUUID();
    const { db, activity } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-claim" },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim");

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", spoofedRunId);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("agent_jwt_run_id_mismatch");
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "auth.agent_jwt_run_header_mismatch",
      entityType: "heartbeat_run",
      entityId: runId,
      runId,
      details: { claimRunId: runId, headerRunId: spoofedRunId },
    });
  });

  it("falls back to the run row responsible user for legacy claim-less agent JWTs", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-legacy" },
    });
    const token = craftAgentJwtWithoutResponsibleClaim({
      secret: process.env.PAPERCLIP_AGENT_JWT_SECRET!,
      agentId,
      companyId,
      adapterType: "codex_local",
      runId,
    });

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      runId,
      onBehalfOfUserId: "user-legacy",
      source: "agent_jwt",
    });
  });

  it("rejects fork-minted run JWTs before issue reads or writes reach live issue data", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-claim" },
    });

    process.env.PAPERCLIP_INSTANCE_ID = "pap-12899-worktree";
    const forkToken = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim");
    expect(forkToken).not.toBeNull();

    process.env.PAPERCLIP_INSTANCE_ID = "default";
    const app = createApp(db);
    const readRes = await request(app)
      .get(`/companies/${companyId}/issues/${issueId}`)
      .set("Authorization", `Bearer ${forkToken}`)
      .set("X-Paperclip-Run-Id", runId);
    const writeRes = await request(app)
      .patch(`/companies/${companyId}/issues/${issueId}`)
      .set("Authorization", `Bearer ${forkToken}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ title: "should not write" });

    expect(readRes.status).toBe(401);
    expect(writeRes.status).toBe(401);
  });

  it("populates agent-key actors from the key responsible user binding", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const token = "pcp_test_agent_key";
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      agentKey: {
        id: randomUUID(),
        agentId,
        companyId,
        keyHash: hashToken(token),
        responsibleUserId: "user-key",
      },
    });

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId,
      companyId,
      onBehalfOfUserId: "user-key",
      source: "agent_key",
    });
  });

  it("rejects a stored agent API key for a paused agent, and accepts it again after resume", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const token = "pcp_test_agent_key_paused";
    const { db, agentRow } = createDbState({
      agent: { id: agentId, companyId, status: "active" },
      agentKey: {
        id: randomUUID(),
        agentId,
        companyId,
        keyHash: hashToken(token),
        responsibleUserId: "user-key",
      },
    });
    const client = createApp(db);
    const read = () => request(client).get("/actor").set("Authorization", `Bearer ${token}`);

    // The run-JWT branch already rejects `paused`. The long-lived key is not
    // scoped to a run row at all, so nothing else revokes it: `terminate`
    // stamps revokedAt but `pause` does not, and the key outlives the pause for
    // the life of the key. Pause must be revocation here too.
    agentRow.status = "paused";
    const paused = await read();
    expect(paused.status).toBe(403);
    expect(paused.body.code).toBe("agent_paused");
    // Pin the reason this is not a 401: the CLI arms board-auth recovery on
    // any 401 and retries the request with board credentials, and on a 403 it
    // arms only for board/instance-admin messages. If this message ever gains
    // one of those phrases, a paused agent's call gets retried with elevated
    // board credentials.
    expect(paused.body.error).toContain("paused");
    expect(paused.body.error).not.toContain("Board access required");
    expect(paused.body.error).not.toContain("Instance admin required");
    // Pin the whole denial shape, not just the absence of one field: the body
    // must be exactly this, so no actor identity, agent id or key id can leak
    // into it later. `details` mirroring `code` is the error handler's existing
    // behaviour for every `HttpError` with details, not something this change
    // introduces.
    expect(paused.body).toEqual({
      error: "Agent is paused and cannot authenticate",
      code: "agent_paused",
      details: { code: "agent_paused" },
    });

    // The pause -> resume round trip is the lockout guard: resume flips status
    // back to idle and the *same* unrevoked key has to work again. Nothing is
    // re-issued, so this also rules out key revocation on pause.
    agentRow.status = "idle";
    const resumed = await read();
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ type: "agent", agentId, source: "agent_key" });
  });

  it("rejects agent keys that lack a responsible user binding and audits the denial", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const keyId = randomUUID();
    const token = "pcp_test_agent_key_without_user";
    const { db, activity } = createDbState({
      agent: { id: agentId, companyId },
      agentKey: {
        id: keyId,
        agentId,
        companyId,
        keyHash: hashToken(token),
        responsibleUserId: null,
      },
    });

    const res = await request(createApp(db))
      .get(`/companies/${companyId}/protected`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("RESPONSIBLE_USER_UNAVAILABLE");
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "auth.agent_key_missing_responsible_user",
      entityType: "agent_api_key",
      entityId: keyId,
      details: { method: "GET", url: `/companies/${companyId}/protected` },
    });
  });
});
