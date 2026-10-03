import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  agents,
  agentApiKeys,
  boardApiKeys,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  runIdentityContexts,
} from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { isLockNotAvailable } from "../db-errors.js";

type FakeRun = {
  id: string;
  companyId: string;
  agentId: string;
  responsibleUserId: string | null;
  status: string;
  activeIdentityContextId: string | null;
  /** Result of the middleware's `exists (...)` subquery over pending contexts. */
  hasPendingIdentityContext: boolean;
  contextSnapshot: Record<string, unknown>;
  resultJson: Record<string, unknown>;
};

/**
 * Minimal thenable stand-in for a drizzle chain, so the fakes below can offer
 * exactly the terminal methods each call site uses (`.limit`, `.for("update")`)
 * without pretending to be drizzle.
 */
function chain(rowsForTable: (table: unknown) => unknown[]) {
  const builder: Record<string, unknown> = {
    limit: () => builder,
    for: () => builder,
    orderBy: () => builder,
    then: (resolve: (rows: unknown[]) => unknown, reject?: (err: unknown) => unknown) =>
      Promise.resolve(rowsForTable(builder.table)).then(resolve, reject),
  };
  builder.where = () => builder;
  builder.returning = () => Promise.resolve([]);
  builder.set = () => builder;
  builder.from = (table: unknown) => {
    builder.table = table;
    return builder;
  };
  return builder;
}

/**
 * Stands in for the Db the middleware sees, and records whether anything ever
 * opened a transaction. The run row's `hasPendingIdentityContext` is served
 * straight back, mirroring the `exists (...)` subquery the middleware selects.
 * A `null` run models a signed run id that no longer resolves to a row.
 */
function createDb(
  run: FakeRun | null,
  pendingIdentityContexts: unknown[],
  steeringReceipt?: unknown,
  agent: { id: string; companyId: string; status?: string } = {
    id: run?.agentId ?? "",
    companyId: run?.companyId ?? "",
    status: "active",
  },
) {
  const state = { transactions: 0, executed: [] as string[] };
  const rowsFor = (table: unknown) => {
    if (table === boardApiKeys) return [];
    if (table === agentApiKeys) return [];
    if (table === agents) {
      return [{ id: agent.id, companyId: agent.companyId, status: agent.status ?? "active" }];
    }
    if (table === heartbeatRuns) return run ? [run] : [];
    if (table === runIdentityContexts) return pendingIdentityContexts;
    if (table === heartbeatRunEvents) return steeringReceipt ? [steeringReceipt] : [];
    if (table === issues) return [{ id: "issue-1" }];
    return [];
  };
  const tx = {
    execute: async (statement: { queryChunks?: unknown[] }) => {
      state.executed.push(JSON.stringify(statement.queryChunks ?? []));
      return { rows: [] };
    },
    select: () => chain(rowsFor),
    insert: () => ({ values: () => Promise.resolve([]) }),
    update: () => chain(rowsFor),
  };
  const db = {
    select: () => chain(rowsFor),
    insert: () => ({ values: () => Promise.resolve([]) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    transaction: async (fn: (executor: unknown) => unknown) => {
      state.transactions += 1;
      return fn(tx);
    },
  } as any;
  return { db, state };
}

function createApp(db: unknown) {
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(db as never, { deploymentMode: "local_trusted" }));
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  app.post("/actor", (req, res) => {
    res.json(req.actor);
  });
  app.use(errorHandler);
  return app;
}

describe("run-JWT auth resolves identity without taking row locks", () => {
  const companyId = "11111111-1111-4111-8111-111111111111";
  const agentId = "22222222-2222-4222-8222-222222222222";
  const runId = "33333333-3333-4333-8333-333333333333";
  const activeContextId = "44444444-4444-4444-8444-444444444444";
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const originalTtl = process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
  const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "run-identity-auth-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "3600";
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

  const run = (overrides: Partial<FakeRun> = {}): FakeRun => ({
    id: runId,
    companyId,
    agentId,
    responsibleUserId: "operator-1",
    status: "running",
    activeIdentityContextId: activeContextId,
    hasPendingIdentityContext: false,
    contextSnapshot: {},
    resultJson: {},
    ...overrides,
  });

  const token = () => {
    const jwt = createLocalAgentJwt(agentId, companyId, "opencode_local", runId, "operator-1");
    expect(jwt).toBeTruthy();
    return jwt as string;
  };

  it("takes no transaction when the run has no pending steered identity", async () => {
    const { db, state } = createDb(run(), []);

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token()}`);

    expect(res.status).toBe(200);
    // The whole point of the fix: an ordinary authenticated request resolves
    // identity from the run row it already read, so it never opens the
    // two-FOR-UPDATE capture transaction.
    expect(state.transactions).toBe(0);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId,
      companyId,
      runId,
      identityContextId: activeContextId,
      onBehalfOfUserId: "operator-1",
      source: "agent_jwt",
    });
  });

  it("still acknowledges a pending steered identity, with the lock wait bounded", async () => {
    const messageId = "77777777-7777-4777-8777-777777777777";
    const pending = {
      id: "55555555-5555-4555-8555-555555555555",
      companyId,
      runId,
      messageId,
      status: "pending",
      responsibleUserId: "operator-2",
      parentContextId: activeContextId,
    };
    // The durable steering receipt the capture requires before it will accept a
    // pending identity: without it production correctly answers 409.
    const receipt = {
      payload: {
        prpEvent: {
          turnId: "turn-9",
          payload: { kind: "steering_acknowledgement", itemId: `msg-1:steer:${messageId}` },
        },
      },
    };
    const { db, state } = createDb(run({ hasPendingIdentityContext: true }), [pending], receipt);

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token()}`);

    expect(res.status).toBe(200);
    // Steering really is waiting, so the locked capture must run...
    expect(state.transactions).toBe(1);
    // ...and it must bound its own wait rather than park the request for as
    // long as the blocking transaction holds the row.
    expect(state.executed.join("\n")).toContain("set local lock_timeout");
    expect(res.body).toMatchObject({
      identityContextId: pending.id,
      onBehalfOfUserId: "operator-2",
    });
  });

  it("leaves the run row untouched when it has no active identity context", async () => {
    const { db, state } = createDb(run({ activeIdentityContextId: null }), [
      { id: "66666666-6666-4666-8666-666666666666", runId, status: "pending", responsibleUserId: null },
    ]);

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token()}`);

    expect(res.status).toBe(200);
    expect(state.transactions).toBe(0);
  });
});

/**
 * The run JWT is authorized against the run row it names, not against the
 * agent alone. These cover the three revocation gaps where the signed hint was
 * accepted without the run row agreeing.
 */
describe("run-JWT authorization is scoped to a live run row", () => {
  const companyId = "11111111-1111-4111-8111-111111111111";
  const agentId = "22222222-2222-4222-8222-222222222222";
  const runId = "33333333-3333-4333-8333-333333333333";
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const originalTtl = process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
  const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "run-revocation-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "3600";
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

  const run = (overrides: Partial<FakeRun> = {}): FakeRun => ({
    id: runId,
    companyId,
    agentId,
    responsibleUserId: "operator-1",
    status: "running",
    activeIdentityContextId: null,
    hasPendingIdentityContext: false,
    contextSnapshot: {},
    resultJson: {},
    ...overrides,
  });

  const token = () => {
    const jwt = createLocalAgentJwt(agentId, companyId, "opencode_local", runId, "operator-1");
    expect(jwt).toBeTruthy();
    return jwt as string;
  };

  it.each([
    { label: "cancelled", row: { status: "cancelled" } },
    { label: "cancellation requested", row: { status: "running", resultJson: { executionCancellation: { state: "requested" } } } },
  ])("rejects a GET from a run with $label", async ({ row }) => {
    const { db } = createDb(run(row), []);

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token()}`);

    // Reads used to be carved out of the revocation, which left a stopped run's
    // 48h token with company-wide read access to issues, documents and secrets.
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("agent_run_cancelled");
  });

  it("reports a cancelled conversation turn distinctly", async () => {
    const { db } = createDb(run({ status: "cancelled", contextSnapshot: { conversationMode: true } }), []);

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token()}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("conversation_turn_cancelled");
  });

  it("rejects reads and writes for a paused agent whose run row is still running", async () => {
    const { db } = createDb(run(), [], undefined, { id: agentId, companyId, status: "paused" });
    const app = createApp(db);

    const read = await request(app).get("/actor").set("Authorization", `Bearer ${token()}`);
    const write = await request(app).post("/actor").set("Authorization", `Bearer ${token()}`).send({});

    // The plugin and budget pause paths never cancel runs, so the run row stays
    // `running`; only the agent status says this agent should stop.
    expect(read.status).toBe(401);
    expect(write.status).toBe(401);
    expect(read.body.error).toContain("paused");
  });

  it("rejects a token whose signed run id resolves to no row", async () => {
    // The agent is healthy and in the right company; only the run row is gone.
    const { db } = createDb(null, [], undefined, { id: agentId, companyId });
    const app = createApp(db);

    const read = await request(app).get("/actor").set("Authorization", `Bearer ${token()}`);
    const write = await request(app).post("/actor").set("Authorization", `Bearer ${token()}`).send({});

    expect(read.status).toBe(401);
    expect(write.status).toBe(401);
    expect(read.body.error).toContain("no longer exists");
  });

  it("still authenticates a live run row", async () => {
    const { db, state } = createDb(run(), []);

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token()}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "agent", agentId, companyId, runId, source: "agent_jwt" });
    expect(state.transactions).toBe(0);
  });
});

describe("the pending-identity probe renders a correlated exists subquery", () => {
  it("stays one read against the run row, with no lock and no extra round trip", () => {
    const query = drizzle({} as never).select({
      activeIdentityContextId: heartbeatRuns.activeIdentityContextId,
      hasPendingIdentityContext: sql`exists (
        select 1 from ${runIdentityContexts} c
        where c.run_id = "heartbeat_runs"."id" and c.status = 'pending'
      )`,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.id, "00000000-0000-4000-8000-000000000000"));

    const { sql: text } = query.toSQL();
    const normalized = text.replace(/\s+/g, " ").trim();
    expect(normalized).toContain('exists ( select 1 from "run_identity_contexts" c');
    // The correlation must name the outer table explicitly. Interpolating the
    // column renders it unqualified, which inside this subquery resolves
    // against `run_identity_contexts` itself and silently makes the probe
    // always false.
    expect(normalized).toContain('c.run_id = "heartbeat_runs"."id"');
    expect(normalized).not.toContain('c.run_id = "id"');
    // The probe must stay a plain read. If it ever grew a lock, the auth path
    // would be back to serialising on the hottest rows in the control plane.
    expect(normalized).not.toMatch(/for update/i);
    expect(normalized).toBe(
      'select "active_identity_context_id", exists ( select 1 from "run_identity_contexts" c ' +
        'where c.run_id = "heartbeat_runs"."id" and c.status = \'pending\' ) ' +
        'from "heartbeat_runs" where "heartbeat_runs"."id" = $1',
    );
  });
});

describe("lock timeouts are recognised through the driver error chain", () => {
  it("detects SQLSTATE 55P03 wrapped by drizzle", () => {
    expect(isLockNotAvailable({ cause: { code: "55P03" } })).toBe(true);
    expect(isLockNotAvailable(new Error("x", { cause: { cause: { code: "55P03" } } }))).toBe(true);
    expect(isLockNotAvailable({ code: "23505" })).toBe(false);
    expect(isLockNotAvailable(new Error("unrelated"))).toBe(false);
  });
});