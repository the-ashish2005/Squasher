export interface TrueForgeRuntimeConfig {
  baseUrl: string;
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

export interface StartByterSessionInput {
  issueUrl: string;
  issueTitle: string;
  issueBody: string;
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

export interface StartByterSessionResult {
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
