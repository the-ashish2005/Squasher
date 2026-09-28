import { describe, expect, it } from "vitest";
import { createRun, transitionRun } from "../src/index.js";

const issue = {
  owner: "MAYANK-MAHAUR",
  repo: "Squasher",
  issueNumber: 1,
  url: "https://github.com/MAYANK-MAHAUR/Squasher/issues/1"
};

describe("Squasher state machine", () => {
  it("records a received issue and valid next event", () => {
    const run = createRun("run_1", issue, new Date("2026-08-27T10:00:00.000Z"));
    const next = transitionRun(run, "security-review", "Scanning issue text");

    expect(next.status).toBe("security-review");
    expect(next.events).toHaveLength(2);
    expect(next.events[1]?.message).toBe("Scanning issue text");
  });

  it("rejects unearned green states", () => {
    const run = createRun("run_1", issue);

    expect(() => transitionRun(run, "verified", "Trust me")).toThrow(
      "Invalid Squasher transition: received -> verified"
    );
  });

  it("allows runs to enter a terminal failed state from active work", () => {
    const run = transitionRun(createRun("run_1", issue), "security-review", "Scanning issue text");
    const failed = transitionRun(run, "failed", "Runtime crashed before triage completed");

    expect(failed.status).toBe("failed");
    expect(failed.events.at(-1)).toMatchObject({
      status: "failed",
      message: "Runtime crashed before triage completed"
    });
  });

  it("does not leave the terminal failed state", () => {
    const failed = transitionRun(createRun("run_1", issue), "failed", "Unexpected worker failure");

    expect(() => transitionRun(failed, "triaging", "Try again")).toThrow(
      "Invalid Squasher transition: failed -> triaging"
    );
  });

  it("reaches not-actionable from triage and from a reproduction attempt", () => {
    // A declined change request is its own terminal outcome. Reporting it as
    // not-reproduced would describe work that was never attempted as a failed
    // reproduction, which is what this state exists to avoid.
    const triaged = transitionRun(
      transitionRun(createRun("run_1", issue), "security-review", "Scanning"),
      "triaging",
      "Ready for triage"
    );
    const declined = transitionRun(triaged, "not-actionable", "The request names a service this repo lacks");

    expect(declined.status).toBe("not-actionable");

    const investigated = transitionRun(
      transitionRun(triaged, "environment-building", "Building"),
      "reproducing",
      "Inspecting"
    );
    expect(transitionRun(investigated, "not-actionable", "Ambiguous request").status).toBe("not-actionable");
  });

  it("does not leave the terminal not-actionable state", () => {
    const declined = transitionRun(
      transitionRun(
        transitionRun(createRun("run_1", issue), "security-review", "Scanning"),
        "triaging",
        "Ready"
      ),
      "not-actionable",
      "Out of scope for this project"
    );

    expect(() => transitionRun(declined, "fixing", "Try anyway")).toThrow(
      "Invalid Squasher transition: not-actionable -> fixing"
    );
  });
});
