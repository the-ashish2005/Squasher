const approvalTokenKey = "squasher:approval-token";
const legacyApprovalTokenKey = "byter:approval-token";

import type { RunStatus } from "@squasher/core";
import { apiUrl, type ApprovalActionId, type ChangeRequestView } from "./data";

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

/** Records a requested change against the run. Squasher does not apply it yet. */
export async function submitChangeRequest(runId: string, text: string): Promise<ChangeRequestView> {
  const response = await fetch(apiUrl(`/api/runs/${encodeURIComponent(runId)}/change-requests`), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...approvalAuthHeader() },
    body: JSON.stringify({ text })
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `Change request API returned ${response.status}`);
  return body as unknown as ChangeRequestView;
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
