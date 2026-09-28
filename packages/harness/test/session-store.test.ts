import { describe, expect, it } from "vitest";
import { guardEventType, SessionStore, type HarnessSessionSpec } from "../src/session-store.js";

const spec: HarnessSessionSpec = {
  instructions: "You are Squasher.",
  iterationLimit: 8,
  enabledTools: ["read_issue"],
  approvalRequiredTools: ["create_fix_pull_request"]
};

function newStore() {
  const store = new SessionStore({});
  const session = store.createSession(spec);
  const turn = store.createTurn(session.id);
  return { store, sessionId: session.id, turnId: turn.id };
}

describe("harness session store", () => {
  it("stamps every event with an id, timestamp and monotonic sequence number", () => {
    const { store, sessionId, turnId } = newStore();

    const first = store.appendEvent(sessionId, turnId, { type: "turn.created" });
    const second = store.appendEvent(sessionId, turnId, { type: "model.message", content: "hello" });

    expect(first.sequenceNumber).toBe(1);
    expect(second.sequenceNumber).toBe(2);
    expect(typeof first.event.id).toBe("string");
    expect(typeof first.event.created_at).toBe("string");
    expect(second.event.type).toBe("model.message");
  });

  it("preserves an explicitly supplied event id so approvals can reference it", () => {
    const { store, sessionId, turnId } = newStore();

    const event = store.appendEvent(sessionId, turnId, { id: "evt-source-1", type: "model.message" });

    expect(event.event.id).toBe("evt-source-1");
  });

  it("returns event copies so concurrent appends cannot mutate a reader's array", () => {
    const { store, sessionId, turnId } = newStore();
    store.appendEvent(sessionId, turnId, { type: "turn.created" });

    const snapshot = store.listEvents(sessionId);
    store.appendEvent(sessionId, turnId, { type: "turn.done", state: { status: "completed" } });

    expect(snapshot).toHaveLength(1);
    expect(store.listEvents(sessionId)).toHaveLength(2);

    snapshot[0]!.event.type = "tampered";
    expect(store.listEvents(sessionId)[0]!.event.type).toBe("turn.created");
  });

  it("tags guard failures distinctly and bounds the captured raw text", () => {
    const { store, sessionId, turnId } = newStore();

    const event = store.appendGuardEvent(sessionId, turnId, {
      toolName: "submit_squasher_result",
      attempt: 1,
      outcome: "retrying",
      problem: 'Field "proof.attempts" was wrong.',
      rawText: "x".repeat(20 * 1024)
    });

    expect(event.event.type).toBe(guardEventType);
    expect(event.event.outcome).toBe("retrying");
    expect(event.event.toolName).toBe("submit_squasher_result");
    expect(String(event.event.rawText)).toHaveLength(8 * 1024);
  });

  it("streams only the requested turn and completes on turn.done", async () => {
    const { store, sessionId, turnId } = newStore();
    const otherTurn = store.createTurn(sessionId);

    const collected: string[] = [];
    const consumer = (async () => {
      for await (const envelope of store.subscribeToTurn(sessionId, turnId)) {
        collected.push(String(envelope.event.type));
      }
    })();

    store.appendEvent(sessionId, otherTurn.id, { type: "model.message", content: "other turn" });
    store.appendEvent(sessionId, turnId, { type: "model.message", content: "mine" });
    store.appendEvent(sessionId, turnId, { type: "turn.done", state: { status: "completed" } });

    await consumer;

    expect(collected).toEqual(["model.message", "turn.done"]);
  });

  it("completes the stream on an approval pause, which is terminal but not done", async () => {
    const { store, sessionId, turnId } = newStore();

    const consumer = (async () => {
      const seen: string[] = [];
      for await (const envelope of store.subscribeToTurn(sessionId, turnId)) {
        seen.push(String(envelope.event.type));
      }
      return seen;
    })();

    store.appendEvent(sessionId, turnId, { type: "tool.approval_required", threadId: "main", toolCalls: [] });

    await expect(consumer).resolves.toEqual(["tool.approval_required"]);
  });

  it("releases an open stream when the session is deleted", async () => {
    const { store, sessionId, turnId } = newStore();

    const consumer = (async () => {
      for await (const _envelope of store.subscribeToTurn(sessionId, turnId)) {
        // drain
      }
      return "closed";
    })();

    store.deleteSession(sessionId);

    await expect(consumer).resolves.toBe("closed");
  });

  it("keeps message history across turns so continuations resume the conversation", () => {
    const { store, sessionId } = newStore();

    store.appendMessages(sessionId, [{ role: "system", content: "You are Squasher." }]);
    store.appendMessages(sessionId, [{ role: "user", content: "Analyze issue 1." }]);

    expect(store.messages(sessionId)).toHaveLength(2);
    expect(store.messages(sessionId)[0]?.role).toBe("system");
  });
});
