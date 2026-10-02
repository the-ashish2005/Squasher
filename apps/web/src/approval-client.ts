const approvalTokenKey = "squasher:approval-token";
const legacyApprovalTokenKey = "byter:approval-token";

import type { RunStatus } from "@squasher/core";
import { apiUrl, type ApprovalActionId, type ChangeRequestView, type WorkspaceJobView } from "./data";

export interface ApprovalSubmission {
  id: string;
  runId: string;
  actionId: ApprovalActionId;
  resultStatus: RunStatus;
  message: string;
  savedAt: string;
  pullRequest?: { number: number; url: string };
}

const storagePrefix = "squasher:approval:";
/** Pre-rename prefix, still read so saved decisions survive the upgrade. */
const legacyStoragePrefix = "byter:approval:";

export async function submitApprovalAction(input: {
  runId: string;
  actionId: ApprovalActionId;
  patchHash: string;
}): Promise<ApprovalSubmission> {
  const response = await fetch(apiUrl("/api/approvals"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...approvalAuthHeader()
    },
    body: JSON.stringify(input)
  });
  if (!response.ok) {
    throw new Error(`Approval API returned ${response.status}`);
  }

  const submission = (await response.json()) as ApprovalSubmission;
  window.localStorage.setItem(`${storagePrefix}${input.runId}`, JSON.stringify(submission));
  return submission;
}

/** An answer to a question about a run, from the run's public data only. */
export interface AskAnswer {
  question: string;
  answer: string;
  contextSections: string[];
  missingSections: string[];
  answeredAt: string;
}

/**
 * Asks Squasher about a run. Needs the maintainer token, like an approval, because it spends
 * model time. Throws with the server's own explanation when the feature is not configured.
 */
export async function askSquasher(runId: string, question: string): Promise<AskAnswer> {
  const response = await fetch(apiUrl(`/api/runs/${encodeURIComponent(runId)}/ask`), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...approvalAuthHeader() },
    body: JSON.stringify({ question })
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Ask API returned ${response.status}`);
  return body as unknown as AskAnswer;
}

export interface ChangeRequestSubmission {
  changeRequest: ChangeRequestView;
  /** Squasher's job applying it, when one started. */
  job?: WorkspaceJobView;
  /** Why no job started, when the request was recorded but cannot be applied now. */
  jobError?: string;
}

async function postWorkspace<T>(runId: string, path: string, body: unknown, label: string): Promise<T> {
  const response = await fetch(apiUrl(`/api/runs/${encodeURIComponent(runId)}/${path}`), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...approvalAuthHeader() },
    body: JSON.stringify(body)
  });
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof parsed.error === "string" ? parsed.error : `${label} returned ${response.status}`);
  return parsed as T;
}

/** Records a requested change and asks Squasher to apply it as a new revision. */
export function submitChangeRequest(runId: string, text: string): Promise<ChangeRequestSubmission> {
  return postWorkspace(runId, "change-requests", { text }, "Change request API");
}

/** Re-runs the current patch's tests in a fresh sandbox, or re-verifies it when no commands were recorded. */
export async function startTestRun(runId: string): Promise<WorkspaceJobView> {
  return (await postWorkspace<{ job: WorkspaceJobView }>(runId, "test-runs", {}, "Test run API")).job;
}

/** Submits an approved revision: opens the pull request, or updates the open one. */
export function approveRevision(runId: string, revision: number, hash: string): Promise<{ pullRequest: { number: number; url: string }; updated: boolean; revision: number }> {
  return postWorkspace(runId, `revisions/${revision}/approve`, { hash }, "Revision approval API");
}

function approvalAuthHeader(): Record<string, string> {
  // Falls back to the pre-rename key so a saved token is not lost on upgrade.
  const storedToken =
    window.localStorage.getItem(approvalTokenKey) ?? window.localStorage.getItem(legacyApprovalTokenKey);
  const token = storedToken ?? window.prompt("Approval token") ?? "";
  if (token && !storedToken) {
    window.localStorage.setItem(approvalTokenKey, token);
  }

  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function readApprovalSubmission(runId: string): ApprovalSubmission | undefined {
  const key = `${storagePrefix}${runId}`;
  const legacyKey = `${legacyStoragePrefix}${runId}`;
  // A decision recorded before the rename still belongs to this run.
  const raw = window.localStorage.getItem(key) ?? window.localStorage.getItem(legacyKey);
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as ApprovalSubmission;
  } catch {
    window.localStorage.removeItem(key);
    window.localStorage.removeItem(legacyKey);
    return undefined;
  }
}
