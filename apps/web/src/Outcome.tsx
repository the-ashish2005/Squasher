import { AlertTriangle, Check, CircleDot, ClipboardCheck, FileCode2, GitBranch, GitPullRequestArrow, ListChecks, X } from "lucide-react";
import type { ReactNode } from "react";
import { MarkdownContent } from "./MarkdownContent";
import { contributionTone, implementationTone, type OutcomeSource, type RunOutcome, type RunStatusView } from "./data";

/**
 * Renders the server's account of a run. Every sentence here comes from the run outcome the
 * API derives from the persisted record; these components only lay it out and say where
 * each statement came from.
 */

const sourceLabels: Record<OutcomeSource, string> = {
  agent: "Reported by the agent",
  server: "Recorded by Squasher",
  trace: "Seen in the trace"
};

export function PanelTitle({ eyebrow, title, icon }: { eyebrow: string; title: string; icon: ReactNode }) {
  return <div className="panel-title"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div><span className="panel-icon">{icon}</span></div>;
}

/**
 * The run's two answers side by side: did the engineering succeed, and did the change reach
 * GitHub. A blocked contribution is shown as exactly that, never as a failed run.
 */
export function RunStatusPills({ statuses }: { statuses: { implementation: RunStatusView; contribution: RunStatusView } }) {
  return (
    <>
      <span className={`status-pill status-${implementationTone(statuses.implementation.status)}`} title={statuses.implementation.reason}>
        <CircleDot size={12} />Implementation: {statuses.implementation.label}
      </span>
      <span className={`status-pill status-${contributionTone(statuses.contribution.status)}`} title={statuses.contribution.reason}>
        <GitPullRequestArrow size={12} />Contribution: {statuses.contribution.label}
      </span>
    </>
  );
}

export function SourceTag({ source }: { source: OutcomeSource }) {
  return <span className={`source-tag source-${source}`}>{sourceLabels[source]}</span>;
}

/** "Why this run stopped": the conclusion, its root cause, and the next step. */
export function OutcomePanel({ outcome }: { outcome?: RunOutcome }) {
  if (!outcome) {
    return (
      <section className="panel why-panel">
        <PanelTitle eyebrow="Why this run stopped" title="Outcome not available" icon={<ClipboardCheck size={17} />} />
        <div className="empty-state"><ClipboardCheck size={20} /><p>The server returned no outcome for this record. The timeline and technical details below still show what was recorded.</p></div>
      </section>
    );
  }

  return (
    <section className="panel why-panel outcome-panel">
      <PanelTitle eyebrow="Why this run stopped" title={outcome.headline} icon={<ClipboardCheck size={17} />} />
      {outcome.implementation && outcome.contribution ? (
        <dl className="run-statuses">
          <div className={`run-status status-${implementationTone(outcome.implementation.status)}`}>
            <dt>Implementation</dt>
            <dd>{outcome.implementation.label}</dd>
          </div>
          <div className={`run-status status-${contributionTone(outcome.contribution.status)}`}>
            <dt>Contribution</dt>
            <dd>{outcome.contribution.label}</dd>
          </div>
        </dl>
      ) : undefined}
      <div className={`outcome-statement outcome-${outcome.tone}`}>
        <MarkdownContent value={outcome.statement.text} />
        <SourceTag source={outcome.statement.source} />
      </div>
      <div className="outcome-block">
        <p className="eyebrow">Root cause / explanation</p>
        {outcome.rootCause.established ? (
          <>
            <MarkdownContent value={outcome.rootCause.text} />
            {outcome.rootCause.source ? <SourceTag source={outcome.rootCause.source} /> : undefined}
          </>
        ) : (
          <p className="outcome-missing">{outcome.rootCause.text}</p>
        )}
      </div>
      <div className="outcome-block outcome-next">
        <p className="eyebrow">Next step</p>
        <MarkdownContent value={outcome.nextStep.text} />
        <SourceTag source={outcome.nextStep.source} />
      </div>
    </section>
  );
}

/** "Why no PR?" or "Contribution created", depending on whether a write landed. */
export function ChangeSummary({ change }: { change: RunOutcome["change"] }) {
  return (
    <div className={`change-summary ${change.created ? "created" : ""}`}>
      <strong>{change.title}</strong>
      {change.reasons.length ? <ul className="outcome-reasons">{change.reasons.map((reason) => <li key={reason}><MarkdownContent value={reason} /></li>)}</ul> : undefined}
      {change.branch || change.target ? (
        <div className="approval-meta change-meta">
          {change.branch ? <span><GitBranch size={13} /><code>{change.branch}</code></span> : undefined}
          {change.target ? <span><FileCode2 size={13} />{change.target}</span> : undefined}
        </div>
      ) : undefined}
      {change.verification.length ? (
        <details className="raw-evidence change-verification">
          <summary><ListChecks size={14} />Verification reported by the agent</summary>
          <dl>{change.verification.map((line) => <div key={line.label}><dt>{line.label}</dt><dd><MarkdownContent value={line.text} /></dd></div>)}</dl>
        </details>
      ) : undefined}
    </div>
  );
}

/** "What Squasher checked": the evidence behind the conclusion, each item with its provenance. */
export function OutcomeEvidence({ outcome }: { outcome: RunOutcome }) {
  return (
    <section className="panel outcome-evidence" aria-label="What Squasher checked">
      <PanelTitle eyebrow="Evidence" title="What Squasher checked" icon={<ListChecks size={17} />} />
      {outcome.trace.truncated ? (
        <div className="evidence-note trace-window-note"><AlertTriangle size={16} /><span>Only the last {outcome.trace.retained} trace events are kept for this run, so counts taken from the trace are lower bounds and earlier steps may not be listed.</span></div>
      ) : undefined}
      <ul className="check-list">
        {outcome.checks.map((check) => (
          <li key={check.id} className={`check-row check-${check.state}`}>
            <span className="check-icon" aria-hidden="true">{checkIcon(check.state)}</span>
            <div>
              <strong>{check.label}</strong>
              <MarkdownContent value={check.detail} />
            </div>
            <SourceTag source={check.source} />
          </li>
        ))}
      </ul>
      {outcome.requirements?.length ? (
        <div className="outcome-requirements">
          <p className="eyebrow">Requirement verification</p>
          <ul>
            {outcome.requirements.map((requirement) => (
              <li key={requirement.requirement} className={`requirement requirement-${requirement.verdict}`}>
                <span className="requirement-verdict">{verdictLabel(requirement.verdict)}</span>
                <div>
                  <MarkdownContent value={requirement.requirement} />
                  {requirement.evidence ? <MarkdownContent value={requirement.evidence} className="requirement-evidence" /> : undefined}
                  {requirement.ownership ? (
                    <span className="requirement-owner">{ownershipLabel(requirement.ownership.status)} {requirement.ownership.by}</span>
                  ) : undefined}
                </div>
              </li>
            ))}
          </ul>
          <SourceTag source="agent" />
        </div>
      ) : undefined}
      {outcome.claims?.length ? (
        <div className="outcome-claims">
          <p className="eyebrow">Discussion claims checked against the repository</p>
          <ul>
            {outcome.claims.map((claim) => (
              <li key={claim.claim} className={`claim claim-${claim.verdict}`}>
                <span className="requirement-verdict">{claimVerdictLabel(claim.verdict)}</span>
                <div>
                  <p className="claim-label">The discussion says</p>
                  <MarkdownContent value={claim.claim} />
                  <p className="claim-label">The repository shows</p>
                  <MarkdownContent value={claim.evidence} />
                </div>
              </li>
            ))}
          </ul>
          <SourceTag source="agent" />
        </div>
      ) : undefined}
      {outcome.findings.length ? (
        <div className="outcome-findings">
          <p className="eyebrow">Findings reported by the agent</p>
          <ul>{outcome.findings.map((finding) => <li key={finding}><MarkdownContent value={finding} /></li>)}</ul>
        </div>
      ) : undefined}
    </section>
  );
}

function ownershipLabel(status: string): string {
  if (status === "reserved") return "Reserved by";
  if (status === "offered") return "Offered to";
  if (status === "claimed") return "Claimed by";
  return "Owned by";
}

function claimVerdictLabel(verdict: string): string {
  if (verdict === "confirmed") return "Confirmed";
  if (verdict === "partly-confirmed") return "Partly true";
  if (verdict === "contradicted") return "Contradicted";
  return "Unverified";
}

function verdictLabel(verdict: string): string {
  if (verdict === "pass") return "Pass";
  if (verdict === "missing") return "Missing";
  if (verdict === "fail") return "Fail";
  if (verdict === "already-implemented") return "Already implemented";
  if (verdict === "out-of-scope") return "Out of scope";
  return verdict;
}

function checkIcon(state: RunOutcome["checks"][number]["state"]): ReactNode {
  if (state === "done") return <Check size={14} />;
  if (state === "failed") return <X size={14} />;
  if (state === "not-observed" || state === "discrepancy") return <AlertTriangle size={14} />;
  return <CircleDot size={14} />;
}
