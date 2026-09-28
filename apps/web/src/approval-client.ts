const approvalTokenKey = "squasher:approval-token";
const legacyApprovalTokenKey = "byter:approval-token";

import type { RunStatus } from "@squasher/core";
import { apiUrl, type ApprovalActionId } from "./data";

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
