export interface TrueForgeRuntimeConfig {
  baseUrl?: string;
  token?: string;
  modelName: string;
  modelProvider?: string;
  mcpServerName?: string;
}

export interface TrueForgeSession {
  id: string;
  title: string | null;
}

export interface TrueForgeTurn {
  id: string;
  sessionId: string;
  status: string;
}

export interface TrueForgeRuntimeEvent {
  sequenceNumber?: number;
  type: string;
  raw: unknown;
}

export type TrueForgeRuntimeEventListener = (event: TrueForgeRuntimeEvent) => void | Promise<void>;

export interface StartSquasherSessionInput {
  issueUrl: string;
  issueTitle: string;
  issueBody: string;
  /**
   * The issue's comment thread, already bounded and rendered as text by the server. Handed
   * to the agent in its first message so the maintainers' current direction is in front of
   * it before any code is read, and so it survives the tool-output budget, which only ever
   * elides tool results.
   */
  issueDiscussion?: string;
  /**
   * Set when this session revises a patch a human is reviewing, rather than solving the
   * issue from scratch. The session gets no GitHub write tool: a revision is only ever
   * submitted later, by a human's approval in the Contribution Workspace.
   */
  revision?: PatchRevisionRequest;
  repository: string;
  baseBranch: string;
  branchName: string;
  baseSha?: string;
}

export interface ResolveToolApprovalInput {
  sessionId: string;
  previousTurnId: string;
  threadId: string;
  toolCallId: string;
  decision: "allow" | "deny";
  reason?: string;
}

export interface StartSquasherSessionResult {
  session: TrueForgeSession;
  turn: TrueForgeTurn;
}

export interface TrueForgePartialSessionFailureDetails {
  session: TrueForgeSession;
  cause: unknown;
  cleanupAttempted: boolean;
  cleanupSucceeded: boolean;
  cleanupError?: unknown;
}

export interface TrueForgeClientLike {
  sessions: {
    create(request: unknown): Promise<unknown>;
    createTurn(sessionId: string, request: unknown): Promise<unknown>;
    delete?(sessionId: string): Promise<unknown>;
    createTurnStream?(sessionId: string, request: unknown): Promise<AsyncIterable<unknown>>;
    listEvents(sessionId: string, request?: unknown): Promise<unknown>;
    subscribeToTurn?(sessionId: string, turnId: string, request?: unknown): Promise<AsyncIterable<unknown>>;
  };
}

export interface PatchRevisionRequest {
  /** "apply-change" edits the patch; "verify" leaves it alone and re-verifies it. */
  mode: "apply-change" | "verify";
  /** The patch as it stands now: every file in full. */
  files: Array<{ path: string; content: string }>;
  /** The human's request, for "apply-change". */
  changeRequest?: string;
  /** The requirements the patch was verified against, as the reviewer saw them. */
  requirements?: Array<{ requirement: string; verdict: string }>;
  /** Earlier requested changes already applied, oldest first, so they are kept. */
  previousChanges?: string[];
}
