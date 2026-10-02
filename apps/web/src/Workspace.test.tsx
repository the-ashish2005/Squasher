// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { toDashboardRunFromWebhook } from "./data";
import { ContributionWorkspace, type WorkspaceActions } from "./Workspace";

/**
 * The Contribution Workspace, rendered in a DOM and clicked through. Fixtures are shaped
 * like the public run API's output, including what it leaves out.
 */

type WebhookRecord = Parameters<typeof toDashboardRunFromWebhook>[0];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
});

const verified = {
  implementation: { status: "verified", label: "Verified", reason: "The change was verified with executed evidence" },
  contribution: { status: "awaiting_approval", label: "Awaiting approval", reason: "The GitHub write is paused for a maintainer's approval" }
};

const dependabot = 'version: 2\nupdates:\n  - package-ecosystem: "pip"\n    directory: "/"\n    schedule:\n      interval: "weekly"\n';

function record(overrides: {
  status?: string;
  statuses?: unknown;
  policy?: unknown;
  result?: Record<string, unknown>;
  omitOptional?: boolean;
  extra?: Record<string, unknown>;
} = {}): WebhookRecord {
  const result = overrides.omitOptional
    ? {
        status: "patch-ready",
        summary: "Fixes the tokenizer.",
        candidatePatch: { title: "Fix tokenizer", body: "Guards the escape.", baseBranch: "main", branchName: "squasher/fix-7-a", files: [{ path: "src/tokenizer.ts", content: "export const fixed = true;\n" }], hash: "a".repeat(64), verifiedAt: "2026-09-30T00:00:00Z" }
      }
    : {
        status: "implemented-feature",
        summary: "Adds the requested Dependabot configuration.",
        requirements: [
          { requirement: "A pip entry, weekly", verdict: "pass", evidence: "Validator OK 3/3." },
          { requirement: "A github-actions entry, weekly", verdict: "pass", evidence: "Validator OK 3/3." },
          { requirement: "Cards and badges", verdict: "missing", evidence: "Not requested here.", ownership: { status: "reserved", by: "@drkrillo" } }
        ],
        fileChanges: [{ path: ".github/dependabot.yml", summary: "Adds weekly Dependabot updates requested by issue #174.", requirements: ["A pip entry, weekly"] }],
        proof: {
          before: "The file was missing: validator failed 3/3.",
          after: "The validator passed 3/3.",
          regressions: "`pytest -q` reported 83 passed with 100% coverage.",
          attempts: "3/3 before and 3/3 after"
        },
        candidatePatch: {
          title: "Add Dependabot version updates",
          body: "Adds dependabot.yml.",
          baseBranch: "main",
          branchName: "squasher/fix-174-a",
          files: [{ path: ".github/dependabot.yml", content: dependabot }],
          hash: "a".repeat(64),
          verifiedAt: "2026-09-30T00:00:00Z"
        },
        patchDiff: [{ path: ".github/dependabot.yml", before: "", after: dependabot, change: "added" }],
        ...overrides.result
      };
  return {
    receivedAt: "2026-09-30T00:00:00Z",
    deliveryId: "ws",
    repository: "drkrillo/good-first-issues",
    issueTitle: "Add Dependabot for pip and GitHub Actions",
    issueBody: "Add dependabot.yml.",
    run: {
      id: "github-drkrillo-good-first-issues-174-ws",
      issue: { owner: "drkrillo", repo: "good-first-issues", issueNumber: 174, url: "https://github.test/i/174" },
      status: overrides.status ?? "awaiting-approval",
      createdAt: "2026-09-30T00:00:00Z",
      updatedAt: "2026-09-30T00:00:00Z",
      events: []
    },
    scan: { safeToExecute: true, findings: [] },
    ...(overrides.statuses === null ? {} : { statuses: overrides.statuses ?? verified }),
    ...(overrides.policy === null
      ? {}
      : {
          policy: overrides.policy ?? {
            verdict: "no-policy-found",
            label: "No AI policy found",
            detail: "The repository's contribution documents say nothing about AI.",
            nextStep: "No stated policy is not permission.",
            automaticContributionAllowed: true,
            signals: []
          }
        }),
    trueForge: {
      status: "paused",
      events: [
        { id: "e1", at: "2026-09-30T00:00:00Z", type: "model.message", category: "sandbox", source: "trueforge", status: "running", summary: "run", command: "python3 -m pytest -q --cov=app" }
      ],
      result
    },
    ...overrides.extra
  } as unknown as WebhookRecord;
}

const runningJob = {
  id: "job-1",
  kind: "apply-change" as const,
  status: "running" as const,
  stage: "Applying the change and re-running tests",
  createdAt: "2026-09-30T01:00:00Z",
  updatedAt: "2026-09-30T01:00:00Z",
  revision: 0,
  changeRequestId: "change-1"
};

function actions(overrides: Partial<WorkspaceActions> = {}): WorkspaceActions {
  return {
    approve: vi.fn().mockResolvedValue(undefined),
    approveRevision: vi.fn().mockResolvedValue({ pullRequest: { number: 176 }, updated: false, revision: 1 }),
    ask: vi.fn().mockResolvedValue({ question: "q", answer: "It adds weekly updates.", contextSections: ["Patch"], missingSections: [], answeredAt: "t" }),
    requestChange: vi.fn().mockResolvedValue({
      changeRequest: { id: "change-1", runId: "r", text: "Don't modify CHANGELOG.md.", createdAt: "t", status: "recorded" },
      job: runningJob
    }),
    runTests: vi.fn().mockResolvedValue({ ...runningJob, id: "job-2", kind: "verify", changeRequestId: undefined, stage: "Re-running the checks" }),
    ...overrides
  };
}

function render(webhookRecord: WebhookRecord, workspaceActions = actions()) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const run = toDashboardRunFromWebhook(webhookRecord);
  act(() => root!.render(<ContributionWorkspace run={run} actions={workspaceActions} />));
  return { html: () => host!.innerHTML, text: () => host!.textContent ?? "", workspaceActions };
}

function click(label: string | RegExp) {
  const button = [...host!.querySelectorAll("button")].find((element) =>
    typeof label === "string" ? element.textContent?.trim() === label : label.test(element.textContent ?? "")
  );
  if (!button) throw new Error(`No button ${String(label)}`);
  act(() => button.click());
  return button;
}

function type(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("contribution workspace", () => {
  it("opens for a verified implementation with its requirements, tests and policy", () => {
    const view = render(record());

    expect(view.text()).toContain("Contribution workspace");
    expect(view.text()).toContain("Add Dependabot version updates");
    // Owned work is not counted against the patch: 2 of the 2 requirements it is responsible for.
    expect(view.text()).toContain("2 / 2 satisfied");
    // Parsed from the agent's text and labelled so; not presented as a separate measurement.
    expect(view.text()).toContain("83 passed");
    expect(view.text()).toContain("As reported by the agent");
    expect(view.text()).toContain("No AI policy found");
    // The work is labelled as generated, whatever the approval.
    expect(view.text()).toContain("generated by Squasher, an automated agent");
  });

  it("explains each changed file from the run, and says when a mapping is not available", () => {
    const view = render(record());
    expect(view.text()).toContain("Adds weekly Dependabot updates requested by issue #174.");
    expect(view.text()).toContain("A pip entry, weekly");

    const bare = render(record({ result: { fileChanges: undefined } }));
    expect(bare.text()).toContain("Explanation not available from the current run data.");
    expect(bare.text()).toContain("Mapping not available from the current run data.");
  });

  it("lists changed files and shows the exact diff with line numbers", () => {
    const view = render(record());
    click(/^Files$/);
    expect(view.text()).toContain(".github/dependabot.yml");
    expect(view.text()).toContain("Added");

    click(/^Diff$/);
    const rows = [...host!.querySelectorAll("tr.diff-added")];
    expect(rows).toHaveLength(6);
    expect(rows[0]!.textContent).toContain("version: 2");
    // Additions are marked in text and for screen readers, not by colour alone.
    expect(rows[0]!.querySelector(".diff-marker")?.getAttribute("aria-label")).toBe("added");
    expect(view.text()).toContain("Current proposed patch same as the original");
  });

  it("does not fake a diff when the original file is unknown", () => {
    const view = render(record({ result: { patchDiff: undefined } }));
    click(/^Diff$/);
    expect(view.text()).toContain("could not be read from the repository, so no diff can be shown");
    expect(host!.querySelectorAll("tr.diff-added")).toHaveLength(0);
  });

  it("shows the recorded verification, and re-verifies with Squasher when no test commands were recorded", async () => {
    const view = render(record());
    click(/^Tests$/);
    expect(view.text()).toContain("The validator passed 3/3.");
    expect(view.text()).toContain("python3 -m pytest -q --cov=app");
    expect(view.text()).toContain("None recorded. Run tests will re-verify the patch with Squasher");
    expect(view.text()).toContain("No test commands were recorded for this version");

    await act(async () => {
      click(/Run tests/);
    });
    expect(view.workspaceActions.runTests).toHaveBeenCalledWith("github-drkrillo-good-first-issues-174-ws");
    expect(view.text()).toContain("Re-verifying the patch:");
  });

  it("shows a recorded test run's commands, exit codes and output, and blocks approval when it failed", () => {
    const view = render(
      record({
        extra: {
          workspaceJobs: [
            {
              id: "job-t",
              kind: "test-run",
              status: "succeeded",
              stage: "Tests failed",
              createdAt: "2026-09-30T02:00:00Z",
              updatedAt: "2026-09-30T02:00:00Z",
              revision: 0,
              testRun: {
                passed: false,
                source: "recorded-commands",
                commands: [
                  { command: "pip install -r requirements.txt", exitCode: 0, durationMs: 4000, stdout: "installed", stderr: "" },
                  { command: "python3 -m pytest -q", exitCode: 1, durationMs: 9000, stdout: "1 failed, 82 passed", stderr: "" }
                ]
              }
            }
          ]
        }
      })
    );

    expect(host!.querySelector(".summary-card.status-danger")?.textContent).toContain("Failed · 1 / 2 commands");
    click(/^Tests$/);
    expect(view.text()).toContain("python3 -m pytest -q");
    expect(view.text()).toContain("exit 1");
    expect(view.text()).toContain("1 failed, 82 passed");
    const approve = [...host!.querySelectorAll(".workspace-actions button")].at(-1) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(view.text()).toContain("The latest test run of this version failed");
  });

  it("starts applying a requested change and shows Squasher working, without claiming it is done", async () => {
    const view = render(record());
    click("Request changes");
    const dialog = host!.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    type(dialog.querySelector("textarea")!, "Don't modify CHANGELOG.md.");
    await act(async () => {
      (dialog.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    });

    expect(view.workspaceActions.requestChange).toHaveBeenCalledWith("github-drkrillo-good-first-issues-174-ws", "Don't modify CHANGELOG.md.");
    expect(view.text()).toContain("Squasher is applying it now in a fresh session");
    expect(view.text()).toContain("the current patch is unchanged until then");
    expect(view.text()).toContain("Squasher is working");
    expect(host!.querySelector('[role="status"][aria-live="polite"]')?.textContent).toContain("Applying the requested change:");
    // Nothing else can start, and nothing can be approved, while it works.
    const buttons = [...host!.querySelectorAll(".workspace-actions button")] as HTMLButtonElement[];
    expect(buttons.find((button) => button.textContent?.includes("Request changes"))!.disabled).toBe(true);
    expect(buttons.find((button) => button.textContent?.includes("Run tests"))!.disabled).toBe(true);
  });

  it("says when a requested change was recorded but could not be started", async () => {
    const view = render(
      record(),
      actions({
        requestChange: vi.fn().mockResolvedValue({
          changeRequest: { id: "change-2", runId: "r", text: "Rename the file.", createdAt: "t", status: "recorded" },
          jobError: "Squasher's agent is not configured on this server"
        })
      })
    );
    click("Request changes");
    const dialog = host!.querySelector('[role="dialog"]')!;
    type(dialog.querySelector("textarea")!, "Rename the file.");
    await act(async () => {
      (dialog.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    });

    expect(view.text()).toContain("Recorded, but not applied: Squasher's agent is not configured on this server");
    expect(view.text()).toContain("Changes requested");
  });

  it("approves through the existing checkpoint, after a confirmation that keeps authorship clear", async () => {
    const view = render(record());
    click("Approve contribution");
    const dialog = host!.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Approving does not make it human-authored");
    await act(async () => {
      click("Approve and continue");
    });

    expect(view.workspaceActions.approve).toHaveBeenCalledWith("approve-pr");
  });

  it("keeps a policy prohibition out of the engineering status, and offers no approval", () => {
    const view = render(
      record({
        status: "patch-ready",
        statuses: {
          implementation: verified.implementation,
          contribution: { status: "blocked", label: "Blocked", reason: "The project's own contribution documents refuse automated contributions" }
        },
        policy: {
          verdict: "prohibited",
          label: "AI contributions prohibited",
          detail: "The repository's own documents refuse contributions like this one.",
          nextStep: "Do not submit this automatically.",
          automaticContributionAllowed: false,
          signals: [{ kind: "ai-prohibited", path: "CONTRIBUTING.md", excerpt: "No AI-generated pull requests." }]
        }
      })
    );

    // The implementation stays verified: the policy is a contribution fact, not a failure.
    expect(host!.querySelector(".summary-card")?.textContent).toContain("Verified");
    expect(view.text()).not.toMatch(/\bFailed\b/);
    const approve = [...host!.querySelectorAll("button")].find((button) => button.textContent?.includes("Approve contribution"))!;
    expect(approve.disabled).toBe(true);
    expect(view.text()).toContain("Squasher will not create a pull request");

    click(/^Final review$/);
    expect(view.text()).toContain("Repository policy prohibits this contribution.");
    expect(view.text()).toContain("No AI-generated pull requests.");
    expect(view.text()).toContain("Copy patch");
    expect(view.text()).toContain("Download patch");
  });

  it("answers questions through the run's own context, and shows why when it cannot", async () => {
    const ask = vi.fn().mockRejectedValue(new Error("Ask Squasher is not configured: no model is available (set DEEPSEEK_API_KEY)"));
    const view = render(record(), actions({ ask }));
    click(/^Ask Squasher$/);
    await act(async () => {
      click("What tests prove this works?");
    });

    expect(ask).toHaveBeenCalledWith("github-drkrillo-good-first-issues-174-ws", "What tests prove this works?");
    expect(host!.querySelector('[role="alert"]')?.textContent).toContain("not configured");
    expect(view.text()).not.toContain("Generated by Squasher's model");
  });

  it("renders a run that lacks every optional field", () => {
    const view = render(record({ omitOptional: true, policy: null, status: "patch-ready", statuses: { ...verified, contribution: { status: "blocked", label: "Blocked", reason: "Not allowlisted" } } }));

    expect(view.text()).toContain("Not recorded");
    expect(view.text()).toContain("No structured count");
    expect(view.text()).toContain("Not available");
    click(/^Evidence$/);
    expect(view.text()).toContain("This run recorded no requirement verification.");
  });

  it("stays compatible with an older record that has no status fields", () => {
    const old = render(record({ statuses: null, policy: null, status: "patch-ready", omitOptional: true }));
    expect(old.text()).toContain("Contribution workspace");
    expect(old.text()).toContain("Not reported");

    // Without a status, a failed run with a patch is not presented as reviewable.
    const failed = render(record({ statuses: null, status: "failed", omitOptional: true }));
    expect(failed.text()).toContain("Nothing to review");
  });

  const revision = {
    number: 1,
    source: "requested-change",
    basedOn: 0,
    createdAt: "2026-09-30T03:00:00Z",
    hash: "r".repeat(64),
    title: "Add Dependabot (monthly)",
    summary: "Switched both schedules to monthly as requested.",
    changeRequestText: "Use a monthly schedule.",
    files: [{ path: ".github/dependabot.yml", content: dependabot.replace("weekly", "monthly") }],
    requirements: [{ requirement: "A pip entry, monthly", verdict: "pass", evidence: "Validator OK 3/3." }],
    testCommands: [{ command: "python3 -m pytest -q", purpose: "suite" }]
  };

  it("reviews the latest revision against the original patch and approves that exact revision", async () => {
    const view = render(record({ status: "patch-ready", statuses: { ...verified, contribution: { status: "blocked", label: "Blocked", reason: "No approval checkpoint is held" } }, extra: { revisions: [revision], changeRequests: [{ id: "change-1", runId: "r", text: "Use a monthly schedule.", createdAt: "t", status: "implemented", revision: 1 }], contribution: { mode: "fork", writable: true, headOwner: "me", reason: "fork" } } }));

    expect(view.text()).toContain("Contribution workspace · Revision 1");
    expect(view.text()).toContain("Add Dependabot (monthly)");
    expect(view.text()).toContain("1 / 1 satisfied");

    click(/^Diff$/);
    expect(view.text()).toContain("Current proposed patch revision 1");
    click("Against the original Squasher patch");
    expect(host!.querySelector("tr.diff-removed")?.textContent).toContain('interval: "weekly"');
    expect(host!.querySelector("tr.diff-added")?.textContent).toContain('interval: "monthly"');

    click(/^Final review$/);
    expect(view.text()).toContain("Revision 1");
    expect(view.text()).toContain("Requested: Use a monthly schedule.");
    expect(view.text()).toContain("Applied · revision 1");

    click("Approve revision 1");
    await act(async () => {
      click("Approve and continue");
    });
    expect(view.workspaceActions.approveRevision).toHaveBeenCalledWith("github-drkrillo-good-first-issues-174-ws", 1, "r".repeat(64));
    expect(view.workspaceActions.approve).not.toHaveBeenCalled();
    expect(view.text()).toContain("Pull request #176 opened with revision 1.");
  });

  it("offers to update an open pull request with a newer revision, and not with the one it already has", () => {
    const withPr = (submittedRevision: number) =>
      record({
        status: "pr-created",
        statuses: { ...verified, contribution: { status: "submitted", label: "Submitted", reason: "Pull request #176 is open" } },
        result: { pullRequest: { number: 176, url: "https://github.test/pull/176" } },
        extra: { revisions: [revision], submittedRevision, contribution: { mode: "fork", writable: true, headOwner: "me", reason: "fork" } }
      });

    const newer = render(withPr(0));
    const update = [...host!.querySelectorAll(".workspace-actions button")].at(-1) as HTMLButtonElement;
    expect(update.textContent).toContain("Update pull request #176 with revision 1");
    expect(update.disabled).toBe(false);
    expect(newer.text()).toContain("Awaiting human review");

    const same = render(withPr(1));
    const done = [...host!.querySelectorAll(".workspace-actions button")].at(-1) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    expect(same.text()).toContain("This version is already in pull request #176.");
  });

  it("does not open for an unverified change", () => {
    const view = render(record({ statuses: { implementation: { status: "implemented", label: "Implemented, not verified", reason: "evidence did not hold" }, contribution: { status: "unavailable", label: "Unavailable", reason: "not verified" } } }));
    expect(view.text()).toContain("The change was not verified");
    expect(host!.querySelector('[role="tablist"]')).toBeNull();
  });

  it("carries no private approval details into the page", () => {
    const leaky = record({
      extra: {
        trueForge: {
          ...(record() as unknown as { trueForge: Record<string, unknown> }).trueForge,
          // The public API strips these; if one ever slipped through, the page must not show it.
          session: { id: "sess-private-123" },
          pendingApproval: { toolCallId: "call-private-789", payloadHash: "f".repeat(64) }
        }
      }
    });
    const view = render(leaky);
    for (const tab of [/^Understand$/, /^Files$/, /^Diff$/, /^Tests$/, /^Evidence$/, /^Final review$/]) {
      click(tab);
      expect(view.html()).not.toContain("call-private-789");
      expect(view.html()).not.toContain("sess-private-123");
    }
  });

  it("uses accessible tabs that move with the arrow keys", () => {
    render(record());
    const tabs = [...host!.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    act(() => tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    const selected = [...host!.querySelectorAll('[role="tab"]')].find((tab) => tab.getAttribute("aria-selected") === "true");
    expect(selected?.textContent).toContain("Files");
    expect(host!.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe(selected?.id);
  });
});
