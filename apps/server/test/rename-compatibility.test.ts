import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signWebhookPayload } from "@squasher/github";
import { createSquasherServer } from "../src/server.js";
import {
  configuredContributionMode,
  isUpstreamAllowlisted,
  scanOpenSquasherPullRequests,
  upstreamAllowlist
} from "../src/contribution.js";
import { brandedEnv } from "../src/env.js";

/**
 * The project was renamed from Byter to Squasher. Everything already in the world when that
 * happened -- .env files, labels on real issues, branches on real forks, browser storage --
 * keeps working under its old name, because a rename that silently dropped settings or
 * stopped recognising existing state would look exactly like the tool breaking.
 */

describe("environment variable aliases", () => {
  it("reads the SQUASHER_ name", () => {
    expect(brandedEnv("CONTRIBUTION_MODE", { SQUASHER_CONTRIBUTION_MODE: "fork" })).toBe("fork");
  });

  it("still reads the pre-rename BYTER_ name", () => {
    expect(brandedEnv("CONTRIBUTION_MODE", { BYTER_CONTRIBUTION_MODE: "fork" })).toBe("fork");
    expect(configuredContributionMode({ BYTER_CONTRIBUTION_MODE: "fork" })).toBe("fork");
    expect(configuredContributionMode({ BYTER_CONTRIBUTION_MODE: "triage" })).toBe("triage");
  });

  it("prefers the new name when both are set, so a migration can go one variable at a time", () => {
    expect(
      brandedEnv("CONTRIBUTION_MODE", { SQUASHER_CONTRIBUTION_MODE: "fork", BYTER_CONTRIBUTION_MODE: "triage" })
    ).toBe("fork");
    expect(
      configuredContributionMode({ SQUASHER_CONTRIBUTION_MODE: "fork", BYTER_CONTRIBUTION_MODE: "triage" })
    ).toBe("fork");
  });

  it("honours an allowlist written under either name", () => {
    expect(upstreamAllowlist({ SQUASHER_UPSTREAM_ALLOWLIST: "a/b" })).toEqual(["a/b"]);
    expect(upstreamAllowlist({ BYTER_UPSTREAM_ALLOWLIST: "a/b" })).toEqual(["a/b"]);
    expect(isUpstreamAllowlisted("A", "B", upstreamAllowlist({ BYTER_UPSTREAM_ALLOWLIST: "a/b" }))).toBe(true);
  });

  it("falls back to the default when neither is set", () => {
    expect(brandedEnv("CONTRIBUTION_MODE", {})).toBeUndefined();
    expect(configuredContributionMode({})).toBe("own");
    expect(upstreamAllowlist({})).toEqual([]);
  });
});

describe("duplicate pull request detection across the rename", () => {
  function clientWithOpenPr(ref: string) {
    return {
      listPullRequests: vi.fn().mockResolvedValue([
        { number: 4, html_url: "https://github.test/pull/4", state: "open", head: { ref, label: `contributor:${ref}` } }
      ])
    };
  }

  it("counts a branch opened under the pre-rename prefix", async () => {
    // A fork can still carry byter/fix-* from before the rename; it occupies a slot just
    // the same as a branch under the current prefix.
    const scan = await scanOpenSquasherPullRequests(
      clientWithOpenPr("byter/fix-42") as never,
      "upstream",
      "project",
      "contributor"
    );

    expect(scan.urls).toEqual(["https://github.test/pull/4"]);
    expect(scan.unreadable).toBe(false);
  });

  it("counts a branch under the current prefix", async () => {
    const scan = await scanOpenSquasherPullRequests(
      clientWithOpenPr("squasher/fix-42") as never,
      "upstream",
      "project",
      "contributor"
    );

    expect(scan.urls).toEqual(["https://github.test/pull/4"]);
  });

  it("ignores an unrelated branch under either prefix", async () => {
    const scan = await scanOpenSquasherPullRequests(
      clientWithOpenPr("feature/x") as never,
      "upstream",
      "project",
      "contributor"
    );

    expect(scan.urls).toEqual([]);
  });
});

describe("trigger label and stale label retraction", () => {
  let staticDir: string;

  beforeEach(async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    process.env.APPROVAL_TOKEN = "approval-token";
    process.env.SQUASHER_REQUIRE_TRIGGER_LABEL = "true";
    delete process.env.SQUASHER_TRIGGER_LABEL;
    delete process.env.BYTER_TRIGGER_LABEL;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.E2B_API_KEY;
    staticDir = await mkdtemp(join(tmpdir(), "byter-rename-static-"));
    await writeFile(join(staticDir, "index.html"), "<main>Squasher</main>", "utf8");
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.APPROVAL_TOKEN;
    delete process.env.SQUASHER_REQUIRE_TRIGGER_LABEL;
  });

  async function deliver(labelName: string, delivery: string) {
    const dataDir = await mkdtemp(join(tmpdir(), "byter-rename-data-"));
    const server = createSquasherServer({ staticDir, dataDir });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const { port } = server.address() as AddressInfo;
    const body = JSON.stringify({
      action: "labeled",
      label: { name: labelName },
      issue: {
        number: 5,
        title: "Tokenizer crashes on a trailing escape",
        body: "It throws a TypeError.",
        html_url: "https://github.test/o/r/issues/5",
        labels: [{ name: labelName }]
      },
      repository: { name: "r", full_name: "o/r", default_branch: "main", owner: { login: "o" } }
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/github/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": delivery,
          "X-Hub-Signature-256": signWebhookPayload(body, "webhook-secret")
        },
        body
      });
      return await response.json();
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }
  }

  it("triggers on the current label", async () => {
    const intake = await deliver("squasher:run", "trigger-new");
    expect(intake.ignored).toBeUndefined();
  });

  it("still triggers on the pre-rename label", async () => {
    // Repositories carry byter:run on existing issues and in their issue templates. A
    // rename that stopped honouring it would read as Squasher having stopped working.
    const intake = await deliver("byter:run", "trigger-legacy");
    expect(intake.ignored).toBeUndefined();
  });

  it("does not trigger on an unrelated label", async () => {
    const intake = await deliver("needs-triage", "trigger-other");
    expect(intake.ignored).toBe(true);
  });

  it("retracts labels left by pre-rename runs", async () => {
    // Reconciliation removes what it owns but no longer wants. If the byter: names were
    // simply dropped from that set, an issue labelled before the rename would keep
    // byter:verified for ever, beside a contradicting squasher: label from a later run.
    const removed: string[] = [];
    const githubClient = {
      addLabels: vi.fn().mockResolvedValue(undefined),
      createLabel: vi.fn().mockResolvedValue(undefined),
      updateLabel: vi.fn().mockResolvedValue(undefined),
      removeLabel: vi.fn(async (_o: string, _r: string, _n: number, name: string) => {
        removed.push(name);
      }),
      createIssueComment: vi.fn().mockResolvedValue({ id: 1, html_url: "https://github.test/c/1" }),
      updateIssueComment: vi.fn().mockResolvedValue({ id: 1, html_url: "https://github.test/c/1" })
    } as never;

    const dataDir = await mkdtemp(join(tmpdir(), "byter-rename-labels-"));
    const server = createSquasherServer({ staticDir, dataDir, githubClient });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const { port } = server.address() as AddressInfo;
    const body = JSON.stringify({
      action: "labeled",
      label: { name: "squasher:run" },
      issue: {
        number: 6,
        title: "Tokenizer crashes on a trailing escape",
        body: "It throws a TypeError.",
        html_url: "https://github.test/o/r/issues/6",
        labels: [{ name: "squasher:run" }]
      },
      repository: { name: "r", full_name: "o/r", default_branch: "main", owner: { login: "o" } }
    });

    try {
      await fetch(`http://127.0.0.1:${port}/api/github/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": "issues",
          "X-GitHub-Delivery": "label-retract-1",
          "X-Hub-Signature-256": signWebhookPayload(body, "webhook-secret")
        },
        body
      });
    } finally {
      await new Promise<void>((closed) => server.close(() => closed()));
    }

    expect(removed).toContain("byter:verified");
    expect(removed).toContain("byter:not-reproduced");
    expect(removed).toContain("byter:awaiting-approval");
    expect(removed).toContain("squasher:verified");
  });
});
