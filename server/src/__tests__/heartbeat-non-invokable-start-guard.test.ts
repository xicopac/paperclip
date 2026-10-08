import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const startLockCalls = vi.hoisted(() => [] as string[]);

vi.mock("../services/agent-start-lock.ts", async () => {
  const actual = await vi.importActual<
    typeof import("../services/agent-start-lock.ts")
  >("../services/agent-start-lock.ts");
  return {
    ...actual,
    withAgentStartLock: <T>(agentId: string, fn: () => Promise<T>) => {
      startLockCalls.push(agentId);
      return actual.withAgentStartLock(agentId, fn);
    },
  };
});

const { heartbeatService } = await import("../services/heartbeat.ts");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres queued-run start guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("queued-run start guard for non-invokable agents", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null =
    null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "heartbeat-non-invokable-start-guard-",
    );
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    startLockCalls.length = 0;
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "issues",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedQueuedRun(agentStatus: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "StartGuardAgent",
      role: "engineer",
      status: agentStatus,
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued work for a non-invokable agent",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    return { companyId, agentId, issueId, runId, wakeupRequestId };
  }

  async function readRun(runId: string) {
    return db
      .select({ status: heartbeatRuns.status, error: heartbeatRuns.error })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  it.each(["paused", "pending_approval"] as const)(
    "returns without taking the agent start lock for a %s agent",
    async (agentStatus) => {
      const { agentId, runId } = await seedQueuedRun(agentStatus);
      const heartbeat = heartbeatService(db);

      await expect(
        heartbeat.resumeQueuedRuns().then(() => heartbeat.drainActiveRunExecutions()),
      ).resolves.toBeUndefined();

      expect(startLockCalls).not.toContain(agentId);
      expect(await readRun(runId)).toMatchObject({ status: "queued" });
    },
    20_000,
  );

  it("still cancels a queued run for a terminated agent under the lock", async () => {
    const { agentId, runId } = await seedQueuedRun("terminated");
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect(startLockCalls).toContain(agentId);
    expect(await readRun(runId)).toMatchObject({ status: "cancelled" });
    expect((await readRun(runId))?.error).toContain("not invokable");
  }, 20_000);

  it("still starts queued work for an invokable agent", async () => {
    const { agentId, runId, wakeupRequestId } = await seedQueuedRun("idle");
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect(startLockCalls).toContain(agentId);
    expect(await readRun(runId)).toMatchObject({ status: "succeeded" });
    const wakeup = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("completed");
  }, 20_000);

  it("leaves no run-log or activity rows behind for a paused agent", async () => {
    const { agentId, runId } = await seedQueuedRun("paused");
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect(startLockCalls).not.toContain(agentId);
    expect(
      await db
        .select()
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.agentId, agentId)),
    ).toEqual([]);
  }, 20_000);
});
