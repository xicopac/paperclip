import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  DASHBOARD_ISSUE_REF_LIMIT,
  DASHBOARD_RECENT_ISSUES_LIMIT,
  dashboardService,
  getUtcMonthStart,
} from "../services/dashboard.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres dashboard service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function utcDay(offsetDays: number): Date {
  const now = new Date();
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays, 12);
  return new Date(day);
}

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function prefix(companyId: string): string {
  return `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

describe("getUtcMonthStart", () => {
  it("anchors the monthly spend window to UTC month boundaries", () => {
    expect(getUtcMonthStart(new Date("2026-03-31T20:30:00.000-05:00")).toISOString()).toBe(
      "2026-04-01T00:00:00.000Z",
    );
    expect(getUtcMonthStart(new Date("2026-04-01T00:30:00.000+14:00")).toISOString()).toBe(
      "2026-03-01T00:00:00.000Z",
    );
  });
});

describeEmbeddedPostgres("dashboard service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dashboard-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("aggregates the full 14-day run activity window without recent-run truncation", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const today = utcDay(0);
    const weekAgo = utcDay(-7);

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "OtherAgent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values([
      ...Array.from({ length: 105 }, () => ({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: today,
      })),
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "failed",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "timed_out",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "cancelled",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        agentId: otherAgentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: weekAgo,
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.runActivity).toHaveLength(14);
    const todayBucket = summary.runActivity.find((bucket) => bucket.date === utcDateKey(today));
    const weekAgoBucket = summary.runActivity.find((bucket) => bucket.date === utcDateKey(weekAgo));

    expect(todayBucket).toMatchObject({
      succeeded: 105,
      failed: 0,
      recovered: 0,
      other: 0,
      total: 105,
      failedByErrorCode: {},
    });
    expect(weekAgoBucket).toMatchObject({
      succeeded: 0,
      failed: 2,
      recovered: 0,
      other: 1,
      total: 3,
      // failed + timed_out with no error code both bucket under "unknown"
      failedByErrorCode: { unknown: 2 },
    });
  });

  it("separates recovered restart kills from true failures and breaks failures down by error code", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const day = utcDay(-2);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const base = {
      companyId,
      agentId,
      invocationSource: "assignment",
      createdAt: day,
    };

    // Direct recovery: a process-loss kill whose retry succeeded.
    const original = randomUUID();
    const retry = randomUUID();
    // Chained recovery: kill -> failed retry -> succeeded retry (both kills recovered).
    const chainedOriginal = randomUUID();
    const chainedRetry = randomUUID();
    const chainedRetrySuccess = randomUUID();
    // A genuine, unrecovered failure that should remain in the failed count.
    const trueFailure = randomUUID();

    await db.insert(heartbeatRuns).values([
      { ...base, id: original, status: "failed", errorCode: "process_lost" },
      { ...base, id: retry, status: "succeeded", retryOfRunId: original },
      { ...base, id: chainedOriginal, status: "failed", errorCode: "process_lost" },
      { ...base, id: chainedRetry, status: "failed", errorCode: "process_lost", retryOfRunId: chainedOriginal },
      { ...base, id: chainedRetrySuccess, status: "succeeded", retryOfRunId: chainedRetry },
      { ...base, id: trueFailure, status: "failed", errorCode: "provider_quota" },
    ]);

    const summary = await dashboardService(db).summary(companyId);
    const bucket = summary.runActivity.find((b) => b.date === utcDateKey(day));

    expect(bucket).toMatchObject({
      succeeded: 2,
      // original + chainedOriginal + chainedRetry all recovered via a later success
      recovered: 3,
      failed: 1,
      other: 0,
      total: 6,
      failedByErrorCode: { provider_quota: 1 },
    });
    // process_lost kills that recovered must not leak into the failed breakdown.
    expect(bucket?.failedByErrorCode.process_lost).toBeUndefined();
  });

  it("returns bounded recent issues, issue refs and trend issues for the dashboard", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const createdLongAgo = utcDay(-20);
    // Distinct, all inside the 14-day trend window, so the descending
    // created_at assertion below is deterministic rather than a tie.
    const createdNewest = utcDay(-1);
    const createdMiddle = utcDay(-3);
    const createdOldest = utcDay(-5);
    const touchedToday = utcDay(0);
    const touchedJustBeforeToday = new Date(utcDay(0).getTime() - 60_000);

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "OtherAgent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    // Visible rows. `updatedAt` is deliberately NOT monotonic with `createdAt`
    // so the two windows cannot pass by sharing one ordering.
    const newest = { id: randomUUID(), identifier: `${prefix(companyId)}-1` };
    const middle = { id: randomUUID(), identifier: `${prefix(companyId)}-2` };
    const oldest = { id: randomUUID(), identifier: `${prefix(companyId)}-3` };
    // Created outside the trend window but touched today: belongs in the
    // recent-task list, must stay out of the trend charts.
    const stale = { id: randomUUID(), identifier: `${prefix(companyId)}-4` };
    const hidden = { id: randomUUID(), identifier: `${prefix(companyId)}-5` };
    const harness = { id: randomUUID(), identifier: `${prefix(companyId)}-6` };
    const otherCompany = { id: randomUUID(), identifier: `${prefix(otherCompanyId)}-1` };

    await db.insert(issues).values([
      {
        id: newest.id,
        companyId,
        identifier: newest.identifier,
        title: "Newest",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        createdAt: createdNewest,
        updatedAt: touchedToday,
      },
      {
        id: middle.id,
        companyId,
        identifier: middle.identifier,
        title: "Middle",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
        createdAt: createdMiddle,
        updatedAt: utcDay(-1),
      },
      {
        id: oldest.id,
        companyId,
        identifier: oldest.identifier,
        title: "Oldest",
        status: "todo",
        priority: "low",
        assigneeAgentId: null,
        createdAt: createdOldest,
        updatedAt: utcDay(-2),
      },
      {
        id: stale.id,
        companyId,
        identifier: stale.identifier,
        title: "Stale but touched",
        status: "done",
        priority: "medium",
        createdAt: createdLongAgo,
        updatedAt: touchedJustBeforeToday,
      },
      {
        id: hidden.id,
        companyId,
        identifier: hidden.identifier,
        title: "Hidden",
        status: "todo",
        priority: "medium",
        hiddenAt: utcDay(0),
        createdAt: createdNewest,
        updatedAt: utcDay(0),
      },
      {
        id: harness.id,
        companyId,
        identifier: harness.identifier,
        title: "Harness",
        status: "todo",
        priority: "medium",
        harnessKind: "eval",
        createdAt: createdNewest,
        updatedAt: utcDay(0),
      },
      {
        id: otherCompany.id,
        companyId: otherCompanyId,
        identifier: otherCompany.identifier,
        title: "Other company",
        status: "todo",
        priority: "medium",
        createdAt: createdNewest,
        updatedAt: utcDay(0),
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.recentIssues?.map((issue) => issue.id)).toEqual([
      newest.id,
      stale.id,
      middle.id,
      oldest.id,
    ]);
    const [topRecent] = summary.recentIssues ?? [];
    expect(topRecent).toMatchObject({
      id: newest.id,
      identifier: newest.identifier,
      title: "Newest",
      status: "in_progress",
      priority: "high",
      updatedAt: touchedToday.toISOString(),
      assigneeAgentId: agentId,
      externalConversationState: null,
    });
    expect(topRecent?.blockerAttention).toMatchObject({ state: "none", reason: null });
    // The endpoint exists to shrink this payload, so the row must not carry
    // more than the contracted fields.
    expect(Object.keys(topRecent ?? {}).sort()).toEqual([
      "assigneeAgentId",
      "blockerAttention",
      "externalConversationState",
      "id",
      "identifier",
      "priority",
      "status",
      "title",
      "updatedAt",
    ]);
    expect(summary.recentIssues?.[2]).toMatchObject({
      id: middle.id,
      status: "blocked",
      assigneeAgentId: agentId,
    });
    expect(summary.recentIssues?.[2]?.blockerAttention?.state).toBe("needs_attention");
    expect(summary.recentIssues?.[3]?.assigneeAgentId).toBeNull();

    const refIds = new Set(summary.issueRefs?.map((ref) => ref.id));
    expect([...refIds].sort()).toEqual(
      [newest.id, middle.id, oldest.id, stale.id].sort(),
    );
    expect(summary.issueRefs).toContainEqual({
      id: newest.id,
      identifier: newest.identifier,
      title: "Newest",
    });

    expect(summary.trendIssues?.map((issue) => issue.id)).toEqual([
      newest.id,
      middle.id,
      oldest.id,
    ]);
    expect(summary.trendIssues?.[0]).toEqual({
      id: newest.id,
      status: "in_progress",
      priority: "high",
      createdAt: createdNewest.toISOString(),
    });
    expect(summary.trendIssues?.some((issue) => issue.id === stale.id)).toBe(false);
  });

  it("caps recent issues at the ten most recently updated visible tasks", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const created = utcDay(-30);
    await db.insert(issues).values(
      Array.from({ length: DASHBOARD_RECENT_ISSUES_LIMIT + 2 }, (_, index) => ({
        id: randomUUID(),
        companyId,
        identifier: `${prefix(companyId)}-${index}`,
        title: `Task ${index}`,
        status: "todo",
        priority: "medium",
        createdAt: created,
        // index 0 is the oldest, so descending updated_at starts at the last index
        updatedAt: new Date(created.getTime() + index * 60_000),
      })),
    );

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.recentIssues).toHaveLength(DASHBOARD_RECENT_ISSUES_LIMIT);
    expect(summary.recentIssues?.[0]?.identifier).toBe(
      `${prefix(companyId)}-${DASHBOARD_RECENT_ISSUES_LIMIT + 1}`,
    );
    expect(summary.recentIssues?.[1]?.identifier).toBe(`${prefix(companyId)}-10`);
    expect(summary.recentIssues?.at(-1)?.identifier).toBe(`${prefix(companyId)}-2`);
    expect(summary.issueRefs).toHaveLength(DASHBOARD_RECENT_ISSUES_LIMIT + 2);
  });

  it("caps issue refs at the visible-issue ref limit", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const created = utcDay(-30);
    const company = prefix(companyId);
    await db.insert(issues).values(
      Array.from({ length: DASHBOARD_ISSUE_REF_LIMIT + 25 }, (_, index) => ({
        id: randomUUID(),
        companyId,
        identifier: `${company}-${index}`,
        title: `Task ${index}`,
        status: "todo",
        priority: "medium",
        createdAt: created,
        updatedAt: created,
      })),
    );

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.issueRefs).toHaveLength(DASHBOARD_ISSUE_REF_LIMIT);
    expect(summary.issueRefs?.[0]).toEqual({
      id: expect.any(String),
      identifier: expect.stringContaining(company),
      title: expect.any(String),
    });
    expect(new Set(summary.issueRefs?.map((ref) => ref.id)).size).toBe(
      DASHBOARD_ISSUE_REF_LIMIT,
    );
    expect(summary.trendIssues).toEqual([]);
    expect(summary.recentIssues).toHaveLength(DASHBOARD_RECENT_ISSUES_LIMIT);
  });

  it("bounds trend issues to a 14-day created_at window newest first", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const insideWindow = randomUUID();
    const justInsideWindow = randomUUID();
    const outsideWindow = randomUUID();
    await db.insert(issues).values([
      {
        id: insideWindow,
        companyId,
        identifier: `${prefix(companyId)}-1`,
        title: "Inside",
        status: "todo",
        priority: "medium",
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      },
      {
        id: justInsideWindow,
        companyId,
        identifier: `${prefix(companyId)}-2`,
        title: "Just inside",
        status: "done",
        priority: "low",
        createdAt: new Date(Date.now() - 13 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(Date.now() - 13 * 24 * 60 * 60 * 1000),
      },
      {
        id: outsideWindow,
        companyId,
        identifier: `${prefix(companyId)}-3`,
        title: "Outside",
        status: "todo",
        priority: "high",
        createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
        updatedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.trendIssues?.map((issue) => issue.id)).toEqual([
      insideWindow,
      justInsideWindow,
    ]);
    expect(summary.issueRefs?.map((ref) => ref.id)).toContain(outsideWindow);
    expect(summary.recentIssues?.map((issue) => issue.id)).toContain(outsideWindow);
  });

  it("returns empty dashboard issue projections for a company with no issues", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.recentIssues).toEqual([]);
    expect(summary.issueRefs).toEqual([]);
    expect(summary.trendIssues).toEqual([]);
  });
});
