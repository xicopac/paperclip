import type { DashboardSummary, IssueBlockerAttention, IssuePriority, IssueStatus } from "@paperclipai/shared";
import { api } from "./client";

/**
 * Presentation-only task row for the dashboard's Recent Tasks list. The board
 * used to fetch the whole issues list (hundreds of rows / megabytes) just to
 * render ten of them plus two name lookups, so the summary endpoint now carries
 * exactly the fields those surfaces read.
 *
 * `updatedAt` is typed `Date | string` because it crosses the wire as an ISO
 * string; both consumers (`getRecentIssues`, `timeAgo`) already normalize.
 */
export interface DashboardRecentIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  updatedAt: Date | string;
  assigneeAgentId: string | null;
  externalConversationState?: "active" | "waiting" | null;
  blockerAttention?: IssueBlockerAttention | null;
}

/**
 * Identifier/title pairs for every issue in the company. Activity feed rows
 * resolve `issue:<id>` to a human label and a hover title; they only ever need
 * those two fields, so the summary ships them instead of whole issue records.
 */
export interface DashboardIssueRef {
  id: string;
  identifier: string | null;
  title: string;
}

/**
 * Status/priority/createdAt for issues created in the last 14 days — the window
 * the Tasks by Priority and Tasks by Status charts bucket by day. Issues older
 * than the window can never land in a bar, so they are not sent.
 */
export interface DashboardTrendIssue {
  id: string;
  status: IssueStatus;
  priority: IssuePriority;
  createdAt: Date | string;
}

/**
 * The dashboard summary as the board consumes it.
 *
 * The issue fields are optional so a UI running against a server that predates
 * the extended summary degrades to empty lists rather than reading `undefined`.
 * `DashboardSummary` itself is owned by `packages/shared`; this local
 * intersection is the board's read contract and needs no cast.
 */
export type DashboardSummaryWithIssues = DashboardSummary & {
  recentIssues?: DashboardRecentIssue[];
  issueRefs?: DashboardIssueRef[];
  trendIssues?: DashboardTrendIssue[];
};

export const dashboardApi = {
  summary: (companyId: string) => api.get<DashboardSummaryWithIssues>(`/companies/${companyId}/dashboard`),
};