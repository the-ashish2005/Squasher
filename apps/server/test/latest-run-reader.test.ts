import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSquasherServer } from "../src/server.js";

/**
 * The dashboard reads the newest run from the tail of webhook-runs.jsonl through a fixed
 * window. One record can be bigger than that window: a candidate patch carries the full
 * text of every file it changes, and the three-file patch from a real run against
 * talkasab/peruse measured 315 KB against a 256 KB window. The run disappeared from the
 * dashboard entirely -- "No persisted webhook runs found" -- while sitting in the file.
 */

function recordFor(options: { delivery: string; receivedAt: string; padBytes: number; status?: string }) {
  return {
    receivedAt: options.receivedAt,
    deliveryId: options.delivery,
    repository: "o/r",
    baseBranch: "main",
    issueTitle: "Serve app.js with cache validation headers",
    issueBody: "The bundle ships without an ETag.",
    run: {
      id: `github-o-r-45-${options.delivery}`,
      issue: { owner: "o", repo: "r", issueNumber: 45, url: "https://github.test/o/r/issues/45" },
      status: options.status ?? "awaiting-approval",
      createdAt: options.receivedAt,
      updatedAt: options.receivedAt,
      events: []
    },
    scan: { safeToExecute: true, findings: [] },
    trueForge: {
      status: "paused",
      result: {
        status: "implemented-improvement",
        summary: "Implemented the requested cache validation headers.",
        candidatePatch: {
          title: "Add cache validation headers",
          body: "Emits ETag and Cache-Control.",
          baseBranch: "main",
          branchName: "squasher/fix-45-abc1234567",
          // Stands in for the full file contents a real patch carries.
          files: [{ path: "server/index.js", content: "x".repeat(options.padBytes) }],
          hash: "a".repeat(64),
          verifiedAt: options.receivedAt
        }
      }
    }
  };
}

describe("latest run reader", () => {
  let staticDir: string;

  beforeEach(async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    process.env.APPROVAL_TOKEN = "approval-token";
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.E2B_API_KEY;
    staticDir = await mkdtemp(join(tmpdir(), "squasher-latest-static-"));
    await writeFile(join(staticDir, "index.html"), "<main>Squasher</main>", "utf8");
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.APPROVAL_TOKEN;
  });

  async function latestFrom(dataDir: string) {
    const server = createSquasherServer({ staticDir, dataDir });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/runs/latest`);
      return { status: response.status, body: await response.json() };
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  }

  it("finds a record larger than the read window", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "squasher-latest-big-"));
    // Comfortably past the 256 KB window, as a real three-file patch was.
    const record = recordFor({ delivery: "big-1", receivedAt: "2026-09-28T00:00:00.000Z", padBytes: 400 * 1024 });
    await writeFile(join(dataDir, "webhook-runs.jsonl"), `${JSON.stringify(record)}\n`, "utf8");

    const latest = await latestFrom(dataDir);

    expect(latest.status).toBe(200);
    expect(latest.body.deliveryId).toBe("big-1");
    expect(latest.body.run.status).toBe("awaiting-approval");
  });

  it("finds an oversized newest record that follows ordinary ones", async () => {
    // The real shape in .data-local: many modest records, then one large one appended by a
    // run whose patch carried whole files. The window covers only part of that last record,
    // so before the fix the endpoint answered 404 even though earlier records sat complete
    // just outside it.
    const dataDir = await mkdtemp(join(tmpdir(), "squasher-latest-mixed-"));
    const older = recordFor({
      delivery: "older",
      receivedAt: "2026-09-27T00:00:00.000Z",
      padBytes: 1024,
      status: "not-reproduced"
    });
    const newer = recordFor({ delivery: "newer", receivedAt: "2026-09-28T00:00:00.000Z", padBytes: 400 * 1024 });
    await writeFile(join(dataDir, "webhook-runs.jsonl"), `${JSON.stringify(older)}\n`, "utf8");
    await appendFile(join(dataDir, "webhook-runs.jsonl"), `${JSON.stringify(newer)}\n`, "utf8");

    const latest = await latestFrom(dataDir);

    expect(latest.status).toBe(200);
    expect(latest.body.deliveryId).toBe("newer");
  });

  it("keeps returning the newest record when several fit the window", async () => {
    // Guards the ordinary path the widening must not disturb: both records are complete in
    // the first window, and the newer one still wins.
    const dataDir = await mkdtemp(join(tmpdir(), "squasher-latest-pair-"));
    const older = recordFor({
      delivery: "older",
      receivedAt: "2026-09-27T00:00:00.000Z",
      padBytes: 1024,
      status: "not-reproduced"
    });
    const newer = recordFor({ delivery: "newer", receivedAt: "2026-09-28T00:00:00.000Z", padBytes: 1024 });
    await writeFile(join(dataDir, "webhook-runs.jsonl"), `${JSON.stringify(older)}\n`, "utf8");
    await appendFile(join(dataDir, "webhook-runs.jsonl"), `${JSON.stringify(newer)}\n`, "utf8");

    expect((await latestFrom(dataDir)).body.deliveryId).toBe("newer");
  });

  it("still reads a small file and reports an empty one as missing", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "squasher-latest-small-"));
    const record = recordFor({ delivery: "small-1", receivedAt: "2026-09-28T00:00:00.000Z", padBytes: 16 });
    await writeFile(join(dataDir, "webhook-runs.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
    expect((await latestFrom(dataDir)).body.deliveryId).toBe("small-1");

    const emptyDir = await mkdtemp(join(tmpdir(), "squasher-latest-empty-"));
    await writeFile(join(emptyDir, "webhook-runs.jsonl"), "", "utf8");
    expect((await latestFrom(emptyDir)).status).toBe(404);
  });
});

describe("stranded approvals", () => {
  let staticDir: string;

  beforeEach(async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    process.env.APPROVAL_TOKEN = "approval-token";
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.E2B_API_KEY;
    staticDir = await mkdtemp(join(tmpdir(), "squasher-stranded-static-"));
    await writeFile(join(staticDir, "index.html"), "<main>Squasher</main>", "utf8");
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.APPROVAL_TOKEN;
  });

  /**
   * Runs written before the approval checkpoint survived a failed write have no paused
   * call left in the harness. The dashboard kept showing them as awaiting-approval, and
   * every click answered "No harness tool call is awaiting approval for this session"
   * with the run unchanged, so the button stayed and the next click did the same.
   */
  it("settles a run whose harness no longer holds the paused call", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "squasher-stranded-"));
    const record = recordFor({ delivery: "stranded-1", receivedAt: "2026-09-28T00:00:00.000Z", padBytes: 64 });
    const patchHash = "a".repeat(64);
    (record.trueForge as Record<string, unknown>).session = { id: "sess-gone", title: null };
    (record.trueForge as Record<string, unknown>).pendingApproval = {
      turnId: "turn-gone",
      threadId: "main",
      toolCallId: "call-gone",
      toolName: "create_fix_pull_request",
      payloadHash: patchHash
    };
    await writeFile(join(dataDir, "webhook-runs.jsonl"), `${JSON.stringify(record)}\n`, "utf8");

    const trueForgeRuntime = {
      resolveToolApproval: async () => {
        throw new Error("No harness tool call is awaiting approval for this session");
      },
      subscribeToTurn: async () => []
    } as never;

    const server = createSquasherServer({ staticDir, dataDir, trueForgeRuntime });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const { port } = server.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer approval-token" },
        body: JSON.stringify({ actionId: "approve-pr", runId: record.run.id, patchHash })
      });
      expect(response.status).toBe(502);

      // The run stops offering an approval it can never honour, and says why.
      const latest = await fetch(`http://127.0.0.1:${port}/api/runs/latest`).then((r) => r.json());
      expect(latest.run.status).toBe("failed");
      expect(latest.run.events.at(-1).message).toContain("cannot be resumed");
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  });
});
