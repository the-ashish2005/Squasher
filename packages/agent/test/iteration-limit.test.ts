import { describe, expect, it } from "vitest";
import { buildSquasherAgentSpec, defaultAgentIterationLimit, resolveIterationLimit } from "../src/index.js";

/**
 * The limit is the runaway-loop guard, so it stays finite and a bad value never removes it.
 * It was raised from 64 after a live run on a real repository exhausted it while making
 * steady, non-repeating progress: 65 tool calls, none repeated, cut off while capturing its
 * before/after proof.
 */

describe("agent iteration limit", () => {
  it("defaults high enough for a large repository, and stays finite", () => {
    expect(resolveIterationLimit({})).toBe(defaultAgentIterationLimit);
    expect(defaultAgentIterationLimit).toBeGreaterThan(64);
    expect(Number.isFinite(defaultAgentIterationLimit)).toBe(true);
  });

  it("is configurable, and honours the pre-rename name", () => {
    expect(resolveIterationLimit({ SQUASHER_ITERATION_LIMIT: "200" })).toBe(200);
    expect(resolveIterationLimit({ BYTER_ITERATION_LIMIT: "200" })).toBe(200);
    expect(
      resolveIterationLimit({ SQUASHER_ITERATION_LIMIT: "200", BYTER_ITERATION_LIMIT: "5" })
    ).toBe(200);
  });

  it("never lets a bad value remove the guard", () => {
    for (const raw of ["0", "-5", "12.5", "lots", "", "Infinity"]) {
      expect(resolveIterationLimit({ SQUASHER_ITERATION_LIMIT: raw }), raw).toBe(defaultAgentIterationLimit);
    }
  });

  it("carries the resolved limit into the agent spec", () => {
    process.env.SQUASHER_ITERATION_LIMIT = "150";
    try {
      expect(buildSquasherAgentSpec({ modelName: "m" }).config.iterationLimit).toBe(150);
    } finally {
      delete process.env.SQUASHER_ITERATION_LIMIT;
    }
    expect(buildSquasherAgentSpec({ modelName: "m" }).config.iterationLimit).toBe(defaultAgentIterationLimit);
  });
});
