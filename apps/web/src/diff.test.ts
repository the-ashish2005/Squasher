import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffFile, unifiedPatch } from "./diff";

describe("line diff", () => {
  it("shows an insertion as one added line, not a shift of everything after it", () => {
    // The previous viewer compared line i to line i, so this showed seven changed lines.
    const diff = diffFile("a\nb\nc\nd\ne\nf\n", "a\nb\nNEW\nc\nd\ne\nf\n");

    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(0);
    const changed = diff.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind !== "context");
    expect(changed).toEqual([{ kind: "added", text: "NEW", newNumber: 3 }]);
  });

  it("carries both line numbers and skips far-away unchanged lines", () => {
    const before = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");
    const after = before.replace("line 30", "line thirty");
    const diff = diffFile(before, after);

    expect(diff.hunks).toHaveLength(1);
    expect(diff.hunks[0]!.skippedBefore).toBe(26);
    expect(diff.hunks[0]!.lines.find((line) => line.kind === "removed")).toMatchObject({ text: "line 30", oldNumber: 30 });
    expect(diff.hunks[0]!.lines.find((line) => line.kind === "added")).toMatchObject({ text: "line thirty", newNumber: 30 });
  });

  it("treats a new file as all additions", () => {
    const diff = diffFile("", "version: 2\nupdates: []\n");
    expect(diff).toMatchObject({ additions: 2, deletions: 0 });
  });

  it("exports a patch that git itself applies, including an added file", () => {
    const before = "a\nb\nc\nd\ne\nf\ng\nh\n";
    const after = "a\nb\nNEW\nc\nd\ne\nf\ng\nH\n";
    const directory = mkdtempSync(join(tmpdir(), "squasher-patch-"));
    execFileSync("git", ["init", "-q"], { cwd: directory });
    writeFileSync(join(directory, "f.txt"), before);
    writeFileSync(
      join(directory, "change.patch"),
      unifiedPatch([
        { path: "f.txt", before, after, added: false },
        { path: ".github/dependabot.yml", before: "", after: "version: 2\n", added: true }
      ])
    );

    execFileSync("git", ["apply", "change.patch"], { cwd: directory });

    expect(readFileSync(join(directory, "f.txt"), "utf8")).toBe(after);
    expect(readFileSync(join(directory, ".github/dependabot.yml"), "utf8")).toBe("version: 2\n");
  });
});
