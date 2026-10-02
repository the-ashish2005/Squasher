import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Check,
  ClipboardCheck,
  Copy,
  Download,
  FileCode2,
  FileDiff,
  GitPullRequestArrow,
  History,
  ListChecks,
  LoaderCircle,
  MessageSquareText,
  PencilLine,
  RefreshCw,
  Scale,
  Send,
  ShieldCheck,
  TestTube2,
  X
} from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AskAnswer, ChangeRequestSubmission } from "./approval-client";
import type { ApprovalActionId, ChangeRequestView, DashboardRun, WorkspaceJobView } from "./data";
import { unifiedPatch, type FileDiff as FileDiffModel } from "./diff";
import { MarkdownContent } from "./MarkdownContent";
import { PanelTitle, SourceTag } from "./Outcome";
import { buildWorkspace, type WorkspaceFile, type WorkspaceModel } from "./workspace-model";

/**
 * The Contribution Workspace: where a human reviews a verified patch before any contribution.
 *
 * Review, understand, approve -- or request a change, which Squasher applies in a fresh
 * session and re-verifies as a new revision, then review again. Everything shown comes from
 * the run. Approving means a human reviewed the work; it never makes the work human-authored.
 */

type TabId = "understand" | "files" | "diff" | "tests" | "evidence" | "ask" | "final";

const tabs: Array<{ id: TabId; label: string; icon: typeof FileDiff }> = [
  { id: "understand", label: "Understand", icon: ClipboardCheck },
  { id: "files", label: "Files", icon: FileCode2 },
  { id: "diff", label: "Diff", icon: FileDiff },
  { id: "tests", label: "Tests", icon: TestTube2 },
  { id: "evidence", label: "Evidence", icon: ListChecks },
  { id: "ask", label: "Ask Squasher", icon: MessageSquareText },
  { id: "final", label: "Final review", icon: ShieldCheck }
];

export interface WorkspaceActions {
  approve: (actionId: ApprovalActionId) => Promise<void>;
  approveRevision: (runId: string, revision: number, hash: string) => Promise<unknown>;
  ask: (runId: string, question: string) => Promise<AskAnswer>;
  requestChange: (runId: string, text: string) => Promise<ChangeRequestSubmission>;
  runTests: (runId: string) => Promise<WorkspaceJobView>;
  /** Re-reads the run so new revisions and job progress appear. */
  refresh?: () => Promise<void>;
}

export function ContributionWorkspace({
  run,
  actions,
  pendingAction,
  approvalError,
  approvalMessage,
  initialTab = "understand"
}: {
  run: DashboardRun;
  actions: WorkspaceActions;
  pendingAction?: ApprovalActionId;
  approvalError?: string;
  approvalMessage?: string;
  initialTab?: TabId;
}) {
  // Requests and jobs started on this page count at once, before the next refresh brings
  // them back from the server, so the page never contradicts what was just done.
  const [localRequests, setLocalRequests] = useState<ChangeRequestView[]>([]);
  const [localJobs, setLocalJobs] = useState<WorkspaceJobView[]>([]);
  const knownRequests = run.changeRequests ?? [];
  const knownJobs = run.workspaceJobs ?? [];
  const model = buildWorkspace({
    ...run,
    changeRequests: [...knownRequests, ...localRequests.filter((entry) => !knownRequests.some((known) => known.id === entry.id))],
    workspaceJobs: [...knownJobs, ...localJobs.filter((entry) => !knownJobs.some((known) => known.id === entry.id))]
  });
  const [tab, setTab] = useState<TabId>(initialTab);
  const [selectedPath, setSelectedPath] = useState<string | undefined>(model.files[0]?.path);
  const [dialog, setDialog] = useState<"request" | "approve" | undefined>();
  const [actionError, setActionError] = useState<string | undefined>();
  const [actionMessage, setActionMessage] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const idPrefix = useId();

  function openFile(path: string, target: TabId = "diff") {
    setSelectedPath(path);
    setTab(target);
  }

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const move = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : event.key === "Home" ? -index : event.key === "End" ? tabs.length - 1 - index : 0;
    if (!move) return;
    event.preventDefault();
    const next = (index + move + tabs.length) % tabs.length;
    setTab(tabs[next]!.id);
    tabRefs.current[next]?.focus();
  }

  async function runTests() {
    setBusy(true);
    setActionError(undefined);
    setActionMessage(undefined);
    try {
      const job = await actions.runTests(run.id);
      setLocalJobs((current) => [...current, job]);
      setActionMessage(job.kind === "verify" ? "Squasher is re-verifying the patch and recording its test commands." : "Tests are running in a fresh sandbox.");
      setTab("tests");
      await actions.refresh?.();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Tests could not be started");
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    setDialog(undefined);
    if (model.approval.kind === "original") {
      await actions.approve("approve-pr");
      return;
    }
    setBusy(true);
    setActionError(undefined);
    setActionMessage(undefined);
    try {
      const outcome = (await actions.approveRevision(run.id, model.current.number, model.current.hash ?? "")) as { pullRequest?: { number: number }; updated?: boolean };
      setActionMessage(
        outcome.updated
          ? `Pull request #${outcome.pullRequest?.number} updated with revision ${model.current.number}.`
          : `Pull request #${outcome.pullRequest?.number} opened with revision ${model.current.number}.`
      );
      await actions.refresh?.();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The revision could not be submitted");
    } finally {
      setBusy(false);
    }
  }

  const backHref = run.harness.dashboardUrl ?? `/runs/${encodeURIComponent(run.id)}`;

  if (!model.available) {
    return (
      <section className="workspace" aria-labelledby={`${idPrefix}-title`}>
        <a className="back-link" href={backHref}><ArrowLeft size={14} />Back to run overview</a>
        <div className="panel workspace-empty">
          <PanelTitle eyebrow="Contribution workspace" title="Nothing to review" icon={<ClipboardCheck size={17} />} />
          <p id={`${idPrefix}-title`}>{model.unavailableReason}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="workspace" aria-labelledby={`${idPrefix}-title`}>
      <div className="workspace-heading">
        <a className="back-link" href={backHref}><ArrowLeft size={14} />Back to run overview</a>
        <p className="eyebrow">Contribution workspace · {model.current.number === 0 ? "Original Squasher patch" : `Revision ${model.current.number}`}</p>
        <h2 id={`${idPrefix}-title`}>{model.current.title ?? run.issueTitle}</h2>
        <p className="workspace-authorship">
          <Bot size={15} aria-hidden="true" />
          <span>
            This patch was generated by Squasher, an automated agent{model.current.number > 0 ? ", including the requested changes" : ""}. Approving records that a
            human reviewed it and wants to continue; it does not make the work human-authored.
          </span>
        </p>
      </div>

      {model.activeJob ? (
        <div className="workspace-progress" role="status" aria-live="polite">
          <LoaderCircle size={16} className="spin" aria-hidden="true" />
          <span><strong>{jobTitle(model.activeJob)}</strong> {model.activeJob.stage}. This page updates on its own.</span>
        </div>
      ) : undefined}

      <WorkspaceSummary model={model} />

      <div className="workspace-tabs" role="tablist" aria-label="Contribution workspace sections">
        {tabs.map(({ id, label, icon: Icon }, index) => (
          <button
            key={id}
            ref={(element) => { tabRefs.current[index] = element; }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`${idPrefix}-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className={tab === id ? "active" : undefined}
            onClick={() => setTab(id)}
            onKeyDown={(event) => onTabKey(event, index)}
          >
            <Icon size={15} aria-hidden="true" />{label}
          </button>
        ))}
      </div>

      <div className="panel workspace-panel" role="tabpanel" id={`${idPrefix}-panel-${tab}`} aria-labelledby={`${idPrefix}-tab-${tab}`}>
        {tab === "understand" ? <UnderstandView model={model} openFile={openFile} /> : undefined}
        {tab === "files" ? <FilesView model={model} selectedPath={selectedPath} onSelect={setSelectedPath} openFile={openFile} /> : undefined}
        {tab === "diff" ? <DiffView model={model} selectedPath={selectedPath} onSelect={setSelectedPath} /> : undefined}
        {tab === "tests" ? <TestsView run={run} model={model} /> : undefined}
        {tab === "evidence" ? <EvidenceView run={run} model={model} /> : undefined}
        {tab === "ask" ? <AskView run={run} ask={actions.ask} /> : undefined}
        {tab === "final" ? <FinalReview run={run} model={model} goTo={setTab} /> : undefined}
      </div>

      <div className="workspace-actions" role="group" aria-label="Review actions">
        <button type="button" className="button" disabled={Boolean(model.activeJob)} aria-describedby={`${idPrefix}-request-note`} onClick={() => setDialog("request")}>
          <PencilLine size={16} aria-hidden="true" />Request changes
        </button>
        <button type="button" className="button" disabled={!model.runTests.possible || busy} aria-describedby={`${idPrefix}-tests-note`} onClick={() => void runTests()}>
          <RefreshCw size={16} aria-hidden="true" />Run tests
        </button>
        <button type="button" className="button" onClick={() => setTab("final")}><FileDiff size={16} aria-hidden="true" />Review final diff</button>
        <button
          type="button"
          className="button button-success"
          disabled={!model.approval.possible || pendingAction !== undefined || busy}
          aria-describedby={`${idPrefix}-approve-note`}
          onClick={() => setDialog("approve")}
        >
          <GitPullRequestArrow size={16} aria-hidden="true" />{pendingAction === "approve-pr" || busy ? "Working" : model.approval.label}
        </button>
        <p className="workspace-action-note" id={`${idPrefix}-request-note`}>
          {model.activeJob ? "Wait for Squasher to finish before requesting another change." : "Squasher applies a requested change in a fresh session, re-runs the tests, and shows it as a new revision."}
        </p>
        <p className="workspace-action-note" id={`${idPrefix}-tests-note`}>{model.runTests.reason}</p>
        <p className="workspace-action-note" id={`${idPrefix}-approve-note`}>{model.approval.reason}</p>
        {approvalError || actionError ? <p className="workspace-action-note error" role="alert">{approvalError ?? actionError}</p> : undefined}
        {approvalMessage || actionMessage ? <p className="workspace-action-note" role="status">{actionMessage ?? approvalMessage}</p> : undefined}
      </div>

      {dialog === "request" ? (
        <RequestChangesDialog
          onClose={() => setDialog(undefined)}
          onSubmit={async (text) => {
            const submitted = await actions.requestChange(run.id, text);
            setLocalRequests((current) => [...current, { ...submitted.changeRequest, status: submitted.job ? "in-progress" : submitted.changeRequest.status }]);
            if (submitted.job) setLocalJobs((current) => [...current, submitted.job!]);
            await actions.refresh?.();
            return submitted;
          }}
        />
      ) : undefined}
      {dialog === "approve" ? <ApproveDialog run={run} model={model} onClose={() => setDialog(undefined)} onConfirm={approve} /> : undefined}
    </section>
  );
}

function jobTitle(job: WorkspaceJobView): string {
  if (job.kind === "apply-change") return "Applying the requested change:";
  if (job.kind === "verify") return "Re-verifying the patch:";
  return "Running tests:";
}

function WorkspaceSummary({ model }: { model: WorkspaceModel }) {
  const tests = model.tests;
  const lastRun = model.latestTestRun?.testRun;
  return (
    <dl className="workspace-summary" aria-label="Review status">
      <div className="summary-card status-success">
        <dt>Implementation</dt>
        <dd>{model.implementation?.label ?? "Not reported"}</dd>
      </div>
      <div className="summary-card">
        <dt>Requirements</dt>
        <dd>{model.requirements.counted ? `${model.requirements.satisfied} / ${model.requirements.counted} satisfied` : "Not recorded"}</dd>
      </div>
      <div className={`summary-card ${lastRun ? (lastRun.passed ? "status-success" : "status-danger") : ""}`}>
        <dt>Tests</dt>
        {lastRun ? (
          <>
            <dd>{lastRun.passed ? "Passed" : "Failed"} · {lastRun.commands.filter((command) => command.exitCode === 0).length} / {lastRun.commands.length} commands</dd>
            <small>Re-run in the workspace</small>
          </>
        ) : (
          <>
            <dd>{tests.passed !== undefined ? `${tests.passed} passed${tests.failed !== undefined ? `, ${tests.failed} failed` : ""}` : "No structured count"}</dd>
            {tests.passed !== undefined ? <small>As reported by the agent</small> : undefined}
          </>
        )}
      </div>
      <div className={`summary-card ${model.policy && !model.policy.automaticContributionAllowed ? "status-warning" : ""}`}>
        <dt>Repository policy</dt>
        <dd>{model.policy?.label ?? "Not available"}</dd>
      </div>
      <div className={`summary-card ${["blocked-by-policy", "changes-requested"].includes(model.review.state) ? "status-warning" : model.review.state === "submitted" ? "status-success" : "status-active"}`}>
        <dt>Review</dt>
        <dd>{model.review.label}</dd>
      </div>
    </dl>
  );
}

function UnderstandView({ model, openFile }: { model: WorkspaceModel; openFile: (path: string) => void }) {
  return (
    <>
      <PanelTitle eyebrow="Understand" title="What changed and why" icon={<ClipboardCheck size={17} />} />
      <ul className="change-cards">
        {model.files.map((file) => (
          <li key={file.path} className="change-card">
            <div className="change-card-head">
              <code>{file.path}</code>
              <ChangeBadge file={file} />
            </div>
            <dl>
              <div>
                <dt>Why it changed</dt>
                <dd>
                  {file.explanation ? (
                    <><MarkdownContent value={file.explanation.summary} /><SourceTag source="agent" /></>
                  ) : (
                    <span className="unavailable">Explanation not available from the current run data.</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Requirement</dt>
                <dd>
                  {file.explanation?.requirements.length ? (
                    <ul className="plain-list">{file.explanation.requirements.map((text) => <li key={text}>{text}</li>)}</ul>
                  ) : (
                    <span className="unavailable">Mapping not available from the current run data.</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Tests and evidence</dt>
                <dd><span className="unavailable">Evidence is recorded for the patch as a whole, not per file. See Tests and Evidence.</span></dd>
              </div>
            </dl>
            <button type="button" className="button" onClick={() => openFile(file.path)}><FileDiff size={15} aria-hidden="true" />View exact change</button>
          </li>
        ))}
      </ul>
      {model.droppedFiles.length ? (
        <p className="unavailable">Removed from the patch by a requested change: {model.droppedFiles.join(", ")}.</p>
      ) : undefined}

      <h3 className="workspace-subheading">Requirement → file mapping</h3>
      {model.mapping?.length ? (
        <ul className="mapping-list">
          {model.mapping.map((entry) => (
            <li key={entry.requirement}>
              <span>{entry.requirement}</span>
              <span aria-hidden="true">→</span>
              <span>{entry.files.map((path) => <button key={path} type="button" className="link-button" onClick={() => openFile(path)}>{path}</button>)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="unavailable">Mapping not available from the current run data.</p>
      )}
    </>
  );
}

function ChangeBadge({ file }: { file: WorkspaceFile }) {
  const label = file.change === "added" ? "Added" : file.change === "modified" ? "Modified" : "Base unknown";
  return (
    <span className={`change-badge change-${file.change}`}>
      {label}
      {file.diff ? <> · <span aria-label={`${file.diff.additions} lines added`}>+{file.diff.additions}</span> <span aria-label={`${file.diff.deletions} lines removed`}>−{file.diff.deletions}</span></> : undefined}
    </span>
  );
}

function FileNav({ model, selectedPath, onSelect, label }: { model: WorkspaceModel; selectedPath?: string; onSelect: (path: string) => void; label: string }) {
  return (
    <nav className="file-nav" aria-label={label}>
      <p className="eyebrow">Files changed ({model.files.length})</p>
      <ul>
        {model.files.map((file) => (
          <li key={file.path}>
            <button type="button" aria-current={selectedPath === file.path ? "true" : undefined} onClick={() => onSelect(file.path)}>
              <FileCode2 size={14} aria-hidden="true" /><span>{file.path}</span><ChangeBadge file={file} />
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function FilesView({ model, selectedPath, onSelect, openFile }: { model: WorkspaceModel; selectedPath?: string; onSelect: (path: string) => void; openFile: (path: string) => void }) {
  const file = model.files.find((entry) => entry.path === selectedPath) ?? model.files[0];
  return (
    <>
      <PanelTitle eyebrow="Files" title="Changed files" icon={<FileCode2 size={17} />} />
      <div className="workspace-split">
        <FileNav model={model} selectedPath={file?.path} onSelect={onSelect} label="Changed files" />
        {file ? (
          <div className="file-detail">
            <div className="change-card-head"><code>{file.path}</code><ChangeBadge file={file} /></div>
            {file.explanation ? <div className="file-why"><MarkdownContent value={file.explanation.summary} /><SourceTag source="agent" /></div> : undefined}
            <button type="button" className="button" onClick={() => openFile(file.path)}><FileDiff size={15} aria-hidden="true" />View diff</button>
            <p className="eyebrow">Proposed content</p>
            <pre className="workspace-code" tabIndex={0} aria-label={`Proposed content of ${file.path}`}>{file.after}</pre>
          </div>
        ) : undefined}
      </div>
    </>
  );
}

/** Lines rendered per file before the rest is hidden behind a button. */
const renderedDiffLines = 1_500;

function DiffView({ model, selectedPath, onSelect }: { model: WorkspaceModel; selectedPath?: string; onSelect: (path: string) => void }) {
  const file = model.files.find((entry) => entry.path === selectedPath) ?? model.files[0];
  const [against, setAgainst] = useState<"base" | "original">("base");
  const compareOriginal = model.current.number > 0 && against === "original";
  return (
    <>
      <PanelTitle eyebrow="Diff" title="Exact change" icon={<FileDiff size={17} />} />
      <VersionNote model={model} />
      {model.current.number > 0 ? (
        <div className="segmented" role="group" aria-label="Compare the current version against">
          <button type="button" aria-pressed={against === "base"} onClick={() => setAgainst("base")}>Against the base branch</button>
          <button type="button" aria-pressed={against === "original"} onClick={() => setAgainst("original")}>Against the original Squasher patch</button>
        </div>
      ) : undefined}
      <div className="workspace-split">
        <FileNav model={model} selectedPath={file?.path} onSelect={onSelect} label="Files in the diff" />
        {file ? <FileDiffView file={file} againstOriginal={compareOriginal} /> : undefined}
      </div>
    </>
  );
}

function VersionNote({ model }: { model: WorkspaceModel }) {
  const applied = model.versions.filter((version) => version.source === "requested-change").length;
  return (
    <div className="revision-note" role="note">
      <span><strong>Original Squasher patch</strong> {model.versions[0]!.files} file{model.versions[0]!.files === 1 ? "" : "s"}</span>
      <span><strong>Requested changes applied</strong> {applied || "none"}</span>
      <span><strong>Current proposed patch</strong> {model.current.number === 0 ? "same as the original" : `revision ${model.current.number}, ${model.files.length} file${model.files.length === 1 ? "" : "s"}`}</span>
    </div>
  );
}

function FileDiffView({ file, againstOriginal }: { file: WorkspaceFile; againstOriginal: boolean }) {
  const [showAll, setShowAll] = useState(false);
  if (againstOriginal) {
    if (file.newInRevision) {
      return <div className="file-detail"><div className="change-card-head"><code>{file.path}</code></div><p className="unavailable">This file is new in the revision: it was not in the original Squasher patch.</p><pre className="workspace-code" tabIndex={0}>{file.after}</pre></div>;
    }
    if (!file.sinceOriginal || file.sinceOriginal.hunks.length === 0) {
      return <div className="file-detail"><div className="change-card-head"><code>{file.path}</code></div><p className="unavailable">Unchanged since the original Squasher patch.</p></div>;
    }
    return (
      <div className="file-detail">
        <div className="change-card-head"><code>{file.path}</code><span className="change-badge change-modified">Changed by request · +{file.sinceOriginal.additions} −{file.sinceOriginal.deletions}</span></div>
        <DiffTable diff={file.sinceOriginal} path={file.path} limit={showAll ? Infinity : renderedDiffLines} />
      </div>
    );
  }
  if (!file.diff) {
    return (
      <div className="file-detail">
        <div className="change-card-head"><code>{file.path}</code><ChangeBadge file={file} /></div>
        <p className="unavailable">The original of this file could not be read from the repository, so no diff can be shown. The proposed content is below.</p>
        <pre className="workspace-code" tabIndex={0}>{file.after}</pre>
      </div>
    );
  }
  return (
    <div className="file-detail">
      <div className="change-card-head"><code>{file.path}</code><ChangeBadge file={file} /></div>
      {file.diff.approximate ? <p className="unavailable">This change is too large to align line by line; the whole file is shown replaced.</p> : undefined}
      <DiffTable diff={file.diff} path={file.path} limit={showAll ? Infinity : renderedDiffLines} />
      {!showAll && countLines(file.diff) > renderedDiffLines ? (
        <button type="button" className="button" onClick={() => setShowAll(true)}>Show all {countLines(file.diff)} lines</button>
      ) : undefined}
    </div>
  );
}

function countLines(diff: FileDiffModel): number {
  return diff.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
}

function DiffTable({ diff, path, limit }: { diff: FileDiffModel; path: string; limit: number }) {
  let rendered = 0;
  return (
    <div className="diff-scroll" tabIndex={0} role="region" aria-label={`Diff of ${path}`}>
      <table className="diff-table">
        <thead className="visually-hidden">
          <tr><th scope="col">Original line</th><th scope="col">New line</th><th scope="col">Change</th><th scope="col">Content</th></tr>
        </thead>
        {diff.hunks.map((hunk, index) => {
          if (rendered >= limit) return undefined;
          const lines = hunk.lines.slice(0, Math.max(0, limit - rendered));
          rendered += lines.length;
          return (
            <tbody key={`${hunk.oldStart}-${hunk.newStart}-${index}`}>
              {hunk.skippedBefore > 0 ? (
                <tr className="diff-skip"><td colSpan={4}>{hunk.skippedBefore} unchanged line{hunk.skippedBefore === 1 ? "" : "s"}</td></tr>
              ) : undefined}
              {lines.map((line, lineIndex) => (
                <tr key={lineIndex} className={`diff-${line.kind}`}>
                  <td className="diff-number">{line.oldNumber ?? ""}</td>
                  <td className="diff-number">{line.newNumber ?? ""}</td>
                  <td className="diff-marker" aria-label={line.kind === "added" ? "added" : line.kind === "removed" ? "removed" : "unchanged"}>
                    {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
                  </td>
                  <td className="diff-text"><code>{line.text || " "}</code></td>
                </tr>
              ))}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}

function TestsView({ run, model }: { run: DashboardRun; model: WorkspaceModel }) {
  const testJobs = [...model.jobs].reverse().filter((job) => job.kind === "test-run" || job.kind === "verify");
  const commands = run.harness.trace.filter((event) => event.category === "sandbox" && event.command && /\b(?:test|pytest|vitest|jest|spec|repro|check|lint|build)\b/i.test(event.command));
  const proof = model.proof;
  return (
    <>
      <PanelTitle eyebrow="Tests" title="Tests and verification" icon={<TestTube2 size={17} />} />

      <h3 className="workspace-subheading">Test runs from the workspace</h3>
      {testJobs.length ? (
        <ol className="test-runs">
          {testJobs.map((job) => <TestRunCard key={job.id} job={job} />)}
        </ol>
      ) : (
        <p className="unavailable">No tests have been re-run from the workspace yet.</p>
      )}

      <h3 className="workspace-subheading">Recorded test commands for this version</h3>
      {model.testCommands?.length ? (
        <ul className="command-list">
          {model.testCommands.map((command) => (
            <li key={command.command}><code>{command.command}</code>{command.purpose ? <span className="workspace-small">{command.purpose}</span> : undefined}</li>
          ))}
        </ul>
      ) : (
        <p className="unavailable">None recorded. Run tests will re-verify the patch with Squasher and record them.</p>
      )}

      <h3 className="workspace-subheading">Verification recorded when this version was made</h3>
      <dl className="proof-list">
        <div><dt>Attempts</dt><dd>{proof?.attempts ? <MarkdownContent value={proof.attempts} /> : <span className="unavailable">Not recorded.</span>}</dd></div>
        <div><dt>Before the change</dt><dd>{proof?.before ? <MarkdownContent value={proof.before} /> : <span className="unavailable">Not recorded.</span>}</dd></div>
        <div><dt>After the change</dt><dd>{proof?.after ? <MarkdownContent value={proof.after} /> : <span className="unavailable">Not recorded.</span>}</dd></div>
        <div><dt>Regression checks</dt><dd>{proof?.regressions ? <MarkdownContent value={proof.regressions} /> : <span className="unavailable">Not recorded.</span>}</dd></div>
      </dl>
      <SourceTag source="agent" />
      {model.current.number === 0 ? (
        <>
          <h3 className="workspace-subheading">Test commands in the original run's trace</h3>
          {commands.length ? (
            <ul className="command-list">{commands.map((event) => <li key={event.id}><code>{event.command}</code><SourceTag source="trace" /></li>)}</ul>
          ) : (
            <p className="unavailable">No test commands are in the retained trace.</p>
          )}
        </>
      ) : undefined}
    </>
  );
}

function TestRunCard({ job }: { job: WorkspaceJobView }) {
  const run = job.testRun;
  const state = job.status === "running" ? "running" : job.status === "failed" ? "failed" : run ? (run.passed ? "passed" : "failed") : "passed";
  return (
    <li className={`test-run test-run-${state}`}>
      <div className="change-card-head">
        <strong>{job.kind === "verify" ? "Re-verification by Squasher" : "Recorded test commands"} · {job.revision === 0 ? "original patch" : `revision ${job.revision}`}</strong>
        <span className={`result-badge ${state === "running" ? "pending" : state}`}>{state === "running" ? job.stage : state === "passed" ? "passed" : "failed"}</span>
      </div>
      <p className="workspace-small"><time dateTime={job.updatedAt}>{new Date(job.updatedAt).toLocaleString()}</time>{job.producedRevision ? ` · recorded as revision ${job.producedRevision}` : ""}</p>
      {job.error ? <p className="workspace-action-note error">{job.error}</p> : undefined}
      {run ? (
        <ul className="command-list">
          {run.commands.map((command, index) => (
            <li key={`${command.command}-${index}`} className="command-result">
              <div className="change-card-head">
                <code>{command.command}</code>
                <span className={`result-badge ${command.exitCode === 0 ? "passed" : "failed"}`}>{command.exitCode === 0 ? "exit 0" : command.exitCode === null ? "did not finish" : `exit ${command.exitCode}`}</span>
              </div>
              {command.stdout || command.stderr ? (
                <details className="raw-evidence">
                  <summary><TestTube2 size={14} aria-hidden="true" />Output ({Math.round(command.durationMs / 1000)}s)</summary>
                  <pre>{[command.stdout, command.stderr].filter(Boolean).join("\n")}</pre>
                </details>
              ) : undefined}
            </li>
          ))}
        </ul>
      ) : undefined}
    </li>
  );
}

function EvidenceView({ run, model }: { run: DashboardRun; model: WorkspaceModel }) {
  return (
    <>
      <PanelTitle eyebrow="Evidence" title="Requirements and evidence" icon={<ListChecks size={17} />} />
      {model.requirements.items.length ? (
        <ul className="requirement-grid">
          {model.requirements.items.map((requirement) => (
            <li key={requirement.requirement} className={`requirement requirement-${requirement.verdict}`}>
              <span className="requirement-verdict">{verdictText(requirement.verdict)}</span>
              <div>
                <MarkdownContent value={requirement.requirement} />
                {requirement.evidence ? <MarkdownContent value={requirement.evidence} className="requirement-evidence" /> : <span className="unavailable">No evidence recorded.</span>}
                {requirement.codeEvidence?.map((cited) => (
                  <p key={`${cited.path}:${cited.excerpt}`} className="cited-code"><code>{cited.path}</code>: <code>{cited.excerpt}</code></p>
                ))}
                {requirement.executedCommand ? <p className="cited-code">Command: <code>{requirement.executedCommand}</code></p> : undefined}
                {requirement.ownership ? <span className="requirement-owner">{requirement.ownership.status} · {requirement.ownership.by}</span> : undefined}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="unavailable">This run recorded no requirement verification.</p>
      )}
      <SourceTag source="agent" />
      {run.discussionClaims?.length ? (
        <>
          <h3 className="workspace-subheading">Discussion claims checked against the repository</h3>
          <ul className="requirement-grid">
            {run.discussionClaims.map((claim) => (
              <li key={claim.claim} className={`claim claim-${claim.verdict}`}>
                <span className="requirement-verdict">{claim.verdict}</span>
                <div>
                  <p className="claim-label">The discussion says</p><MarkdownContent value={claim.claim} />
                  <p className="claim-label">The repository shows</p><MarkdownContent value={claim.evidence} />
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : undefined}
    </>
  );
}

function verdictText(verdict: string): string {
  return verdict === "pass" ? "Pass" : verdict === "fail" ? "Fail" : verdict === "already-implemented" ? "Already implemented" : verdict === "missing" ? "Missing" : verdict === "out-of-scope" ? "Out of scope" : verdict;
}

function AskView({ run, ask }: { run: DashboardRun; ask: WorkspaceActions["ask"] }) {
  const [question, setQuestion] = useState("");
  const [answers, setAnswers] = useState<AskAnswer[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const suggestions = ["Why did you change this file?", "Which requirement does each change satisfy?", "Could this change affect anything else?", "What tests prove this works?"];

  async function submit(text: string) {
    if (text.trim().length < 3) return;
    setBusy(true);
    setError(undefined);
    try {
      const answer = await ask(run.id, text.trim());
      setAnswers((current) => [answer, ...current]);
      setQuestion("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Squasher did not answer");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PanelTitle eyebrow="Ask Squasher" title="Questions about this run" icon={<MessageSquareText size={17} />} />
      <p className="workspace-small">Answers come from this run's issue, discussion, patch, requirements, tests and evidence only. When something is not in the run, the answer says so. Asking needs the maintainer token.</p>
      <div className="suggestions" role="group" aria-label="Suggested questions">
        {suggestions.map((text) => <button key={text} type="button" className="button" disabled={busy} onClick={() => void submit(text)}>{text}</button>)}
      </div>
      <form className="ask-form" onSubmit={(event) => { event.preventDefault(); void submit(question); }}>
        <label htmlFor={inputId}>Your question</label>
        <textarea id={inputId} value={question} rows={3} maxLength={1000} onChange={(event) => setQuestion(event.target.value)} />
        <button type="submit" className="button button-primary" disabled={busy || question.trim().length < 3}><Send size={15} aria-hidden="true" />{busy ? "Asking" : "Ask"}</button>
      </form>
      {error ? <p className="workspace-action-note error" role="alert">{error}</p> : undefined}
      <ol className="answers" aria-live="polite">
        {answers.map((answer) => (
          <li key={answer.answeredAt + answer.question}>
            <p className="answer-question">{answer.question}</p>
            <MarkdownContent value={answer.answer} />
            <p className="workspace-small">Generated by Squasher's model from this run's data.{answer.missingSections.length ? ` Not available to it: ${answer.missingSections.join(", ")}.` : ""}</p>
          </li>
        ))}
      </ol>
    </>
  );
}

const changeRequestStatus: Record<ChangeRequestView["status"], string> = {
  recorded: "Recorded, not applied",
  "in-progress": "Squasher is applying it",
  implemented: "Applied",
  failed: "Could not be applied"
};

function FinalReview({ run, model, goTo }: { run: DashboardRun; model: WorkspaceModel; goTo: (tab: TabId) => void }) {
  const [copied, setCopied] = useState<string | undefined>();
  const exportable = model.files.filter((file) => file.change !== "unknown");
  const excluded = model.files.filter((file) => file.change === "unknown");
  const patchText = exportable.length
    ? unifiedPatch(exportable.map((file) => ({ path: file.path, before: file.before ?? "", after: file.after, added: file.change === "added" })))
    : undefined;
  const prohibited = model.policy && !model.policy.automaticContributionAllowed;
  const applied = model.versions.filter((version) => version.source === "requested-change").length;
  const lastRun = model.latestTestRun?.testRun;

  async function copyPatch() {
    if (!patchText) return;
    try {
      await navigator.clipboard.writeText(patchText);
      setCopied("Patch copied");
    } catch {
      setCopied("Copy failed: your browser blocked clipboard access");
    }
  }

  return (
    <>
      <PanelTitle eyebrow="Final review" title="Before any contribution" icon={<ShieldCheck size={17} />} />
      <dl className="final-review">
        <div><dt>Implementation</dt><dd>{model.implementation?.label ?? "Not reported"}</dd></div>
        <div><dt>Version under review</dt><dd>{model.current.number === 0 ? "Original Squasher patch" : `Revision ${model.current.number}`}</dd></div>
        <div><dt>Requirements</dt><dd>{model.requirements.counted ? `${model.requirements.satisfied} / ${model.requirements.counted} satisfied` : "Not recorded"}</dd></div>
        <div>
          <dt>Tests</dt>
          <dd>
            {lastRun
              ? `Re-run in the workspace: ${lastRun.passed ? "passed" : "failed"}`
              : model.tests.passed !== undefined
                ? `${model.tests.passed} passed${model.tests.failed !== undefined ? `, ${model.tests.failed} failed` : ""} (agent-reported)`
                : "No structured count; see Tests"}
          </dd>
        </div>
        <div><dt>Files changed</dt><dd>{model.files.length}</dd></div>
        <div><dt>Requested changes applied</dt><dd>{applied || "None"}</dd></div>
        <div><dt>Contribution</dt><dd>{model.contribution ? `${model.contribution.label}: ${model.contribution.reason}` : "Not available"}</dd></div>
      </dl>

      <div className={`policy-box ${prohibited ? "blocked" : ""}`}>
        <Scale size={17} aria-hidden="true" />
        <div>
          <strong>Repository policy: {model.policy?.label ?? "Not available"}</strong>
          {model.policy ? <><p>{model.policy.detail}</p><p><strong>Next step:</strong> {model.policy.nextStep}</p></> : <p className="unavailable">This run carries no policy information.</p>}
          {model.policy?.signals.length ? (
            <ul className="policy-findings">
              {model.policy.signals.map((signal) => <li key={`${signal.kind}:${signal.path}`}><code>{signal.path}</code> ({signal.kind}) — “{signal.excerpt}”</li>)}
            </ul>
          ) : undefined}
        </div>
      </div>

      {prohibited ? <p className="policy-verdict" role="note"><AlertTriangle size={16} aria-hidden="true" />Repository policy prohibits this contribution. Squasher will not create a pull request.</p> : undefined}

      <h3 className="workspace-subheading"><History size={15} aria-hidden="true" /> Version history</h3>
      <ol className="version-history">
        {model.versions.map((version) => (
          <li key={version.number} className={version.number === model.current.number ? "current" : undefined}>
            <strong>{version.label}</strong>
            <span>{version.files} file{version.files === 1 ? "" : "s"}{version.source === "verification" ? " · re-verified, unchanged" : ""}{version.submitted ? " · on GitHub" : ""}{version.number === model.current.number ? " · under review" : ""}</span>
            {version.changeRequest ? <span className="workspace-small">Requested: {version.changeRequest}</span> : undefined}
          </li>
        ))}
      </ol>

      {model.changeRequests.length ? (
        <>
          <h3 className="workspace-subheading">Requested changes</h3>
          <ul className="change-requests">
            {model.changeRequests.map((request) => (
              <li key={request.id} className={`change-request-${request.status}`}>
                <MarkdownContent value={request.text} />
                <span className="requirement-owner">{changeRequestStatus[request.status]}{request.revision ? ` · revision ${request.revision}` : ""}</span>
                {request.error ? <p className="workspace-action-note error">{request.error}</p> : undefined}
              </li>
            ))}
          </ul>
        </>
      ) : undefined}

      <div className="technical-links">
        <button type="button" className="button" onClick={() => goTo("diff")}><FileDiff size={15} aria-hidden="true" />View final diff</button>
        <button type="button" className="button" onClick={() => goTo("tests")}><TestTube2 size={15} aria-hidden="true" />View tests</button>
        <button type="button" className="button" onClick={() => goTo("evidence")}><ListChecks size={15} aria-hidden="true" />View evidence</button>
        {patchText ? (
          <>
            <button type="button" className="button" onClick={() => void copyPatch()}><Copy size={15} aria-hidden="true" />Copy patch</button>
            <a className="button" download={`squasher-${run.id}.patch`} href={`data:text/x-diff;charset=utf-8,${encodeURIComponent(patchText)}`}><Download size={15} aria-hidden="true" />Download patch</a>
          </>
        ) : undefined}
      </div>
      {copied ? <p className="workspace-small" role="status">{copied}</p> : undefined}
      {excluded.length ? <p className="unavailable">Not in the exported patch, because their original content is unknown: {excluded.map((file) => file.path).join(", ")}.</p> : undefined}
    </>
  );
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const titleId = useId();
  return (
    <div className="dialog-backdrop" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
      <div className="dialog panel" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dialog-head">
          <h3 id={titleId}>{title}</h3>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function RequestChangesDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (text: string) => Promise<ChangeRequestSubmission> }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<"editing" | "saving" | "done" | "error">("editing");
  const [error, setError] = useState<string | undefined>();
  const [submission, setSubmission] = useState<ChangeRequestSubmission | undefined>();
  const inputId = useId();

  async function submit() {
    setState("saving");
    setError(undefined);
    try {
      setSubmission(await onSubmit(text.trim()));
      setState("done");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The change request was not recorded");
      setState("error");
    }
  }

  return (
    <Dialog title="Request changes" onClose={onClose}>
      {state === "done" ? (
        <div role="status">
          <p><strong>Requested change:</strong> {text}</p>
          {submission?.job ? (
            <p><strong>Status:</strong> Squasher is applying it now in a fresh session, then re-running the tests. It appears as a new revision when its evidence holds; the current patch is unchanged until then.</p>
          ) : (
            <p><strong>Status:</strong> Recorded, but not applied: {submission?.jobError ?? "Squasher could not start on it."}</p>
          )}
          <button type="button" className="button" onClick={onClose}><Check size={15} aria-hidden="true" />Done</button>
        </div>
      ) : (
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label htmlFor={inputId}>Describe the change you want</label>
          <textarea id={inputId} rows={4} maxLength={2000} autoFocus value={text} onChange={(event) => setText(event.target.value)} placeholder="For example: Don't modify CHANGELOG.md." />
          <p className="workspace-small">Squasher applies it in a fresh session, re-runs the tests and checks the requirements. The result is a new revision for you to review; nothing reaches GitHub until you approve it.</p>
          {error ? <p className="workspace-action-note error" role="alert">{error}</p> : undefined}
          <button type="submit" className="button button-primary" disabled={state === "saving" || text.trim().length < 3}>{state === "saving" ? "Sending" : "Request change"}</button>
        </form>
      )}
    </Dialog>
  );
}

function ApproveDialog({ run, model, onClose, onConfirm }: { run: DashboardRun; model: WorkspaceModel; onClose: () => void; onConfirm: () => Promise<void> }) {
  return (
    <Dialog title={model.approval.label} onClose={onClose}>
      <p>You are confirming that you reviewed {model.current.number === 0 ? "this patch" : `revision ${model.current.number}`} and want Squasher to continue with the contribution.</p>
      <ul className="plain-list">
        <li>The patch was generated by Squasher, an automated agent. Approving does not make it human-authored.</li>
        <li>{model.approval.reason}</li>
        {run.pullRequest ? <li>Pull request #{run.pullRequest.number} is already open; this adds one commit to its branch.</li> : undefined}
        {model.policy ? <li>Repository policy: {model.policy.label}. {model.policy.nextStep}</li> : undefined}
      </ul>
      <div className="technical-links">
        <button type="button" className="button button-success" autoFocus onClick={() => void onConfirm()}><GitPullRequestArrow size={15} aria-hidden="true" />Approve and continue</button>
        <button type="button" className="button" onClick={onClose}>Cancel</button>
      </div>
    </Dialog>
  );
}
