export interface DashboardRunActivityDay {
  date: string;
  succeeded: number;
  /**
   * True failures for the day, excluding process-loss/restart kills that were
   * later recovered by a successful retry (those are surfaced in `recovered`).
   */
  failed: number;
  /**
   * Runs that terminated in a failure state (failed/timed_out) but whose retry
   * chain eventually succeeded — e.g. restart-killed runs that recovered. Kept
   * out of `failed` so the headline failure count reflects true, unrecovered
   * failures.
   */
  recovered: number;
  other: number;
  total: number;
  /**
   * Per-error-code breakdown of the (true) `failed` count for the day, so a
   * spike can be attributed to an error class (e.g. `process_lost`,
   * `provider_quota`, `workspace_validation_failed`). Recovered runs are not
   * included here. Runs with no error code are bucketed under `unknown`.
   */
  failedByErrorCode: Record<string, number>;
}

import type { Issue } from "./issue.js";

/** Recent-task row for the dashboard, ordered by `updated_at` desc. Field types
 * mirror `Issue` so the same components accept either source. */
export interface DashboardRecentIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  /** ISO-8601 timestamp. */
  updatedAt: string;
  assigneeAgentId: string | null;
  externalConversationState: Issue["externalConversationState"];
  blockerAttention: Issue["blockerAttention"];
}

/** Id → identifier/title map row for one visible issue in the company. */
export interface DashboardIssueRef {
  id: string;
  identifier: string | null;
  title: string;
}

/** Status/priority chart input, ordered by `created_at` desc inside the window. */
export interface DashboardTrendIssue {
  id: string;
  status: string;
  priority: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
}

export interface DashboardSummary {
  companyId: string;
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
  };
  tasks: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  costs: {
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
  };
  pendingApprovals: number;
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  runActivity: DashboardRunActivityDay[];
  recentIssues?: DashboardRecentIssue[];
  issueRefs?: DashboardIssueRef[];
  trendIssues?: DashboardTrendIssue[];
}
