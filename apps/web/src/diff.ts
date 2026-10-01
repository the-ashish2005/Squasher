/**
 * Line diff for the Contribution Workspace.
 *
 * The earlier viewer compared line i of the original to line i of the change, so a single
 * inserted line marked every line after it as changed. This computes a shortest edit script
 * (Myers' O(ND) algorithm) over lines and groups it into hunks with context, carrying both
 * line numbers, so an insertion shows as exactly one added line.
 */

export type DiffLineKind = "context" | "added" | "removed";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Line number in the original file, absent for an added line. */
  oldNumber?: number;
  /** Line number in the changed file, absent for a removed line. */
  newNumber?: number;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
  /** Unchanged lines skipped before this hunk. */
  skippedBefore: number;
}

export interface FileDiff {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  /** True when the edit distance was too large to compute and the whole file is shown replaced. */
  approximate: boolean;
}

/** Past this many differing lines the exact script is abandoned for a whole-file replacement. */
const maxEditDistance = 4_000;

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  // A trailing newline ends the last line; it does not start an empty one.
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The edit script as a flat list of lines, each kept, added or removed. */
export function diffLines(before: string, after: string): { lines: DiffLine[]; approximate: boolean } {
  const a = splitLines(before);
  const b = splitLines(after);
  const script = myers(a, b);
  if (!script) {
    return {
      approximate: true,
      lines: [
        ...a.map((text, index): DiffLine => ({ kind: "removed", text, oldNumber: index + 1 })),
        ...b.map((text, index): DiffLine => ({ kind: "added", text, newNumber: index + 1 }))
      ]
    };
  }

  const lines: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  for (const operation of script) {
    if (operation === "=") {
      lines.push({ kind: "context", text: a[oldIndex]!, oldNumber: oldIndex + 1, newNumber: newIndex + 1 });
      oldIndex += 1;
      newIndex += 1;
    } else if (operation === "-") {
      lines.push({ kind: "removed", text: a[oldIndex]!, oldNumber: oldIndex + 1 });
      oldIndex += 1;
    } else {
      lines.push({ kind: "added", text: b[newIndex]!, newNumber: newIndex + 1 });
      newIndex += 1;
    }
  }
  return { lines, approximate: false };
}

/** Groups an edit script into hunks, keeping `context` unchanged lines around each change. */
export function diffFile(before: string, after: string, context = 3): FileDiff {
  const { lines, approximate } = diffLines(before, after);
  const additions = lines.filter((line) => line.kind === "added").length;
  const deletions = lines.filter((line) => line.kind === "removed").length;

  const changed = lines.map((line, index) => (line.kind === "context" ? -1 : index)).filter((index) => index >= 0);
  if (changed.length === 0) return { hunks: [], additions, deletions, approximate };

  const keep = new Set<number>();
  for (const index of changed) {
    for (let offset = -context; offset <= context; offset += 1) {
      const position = index + offset;
      if (position >= 0 && position < lines.length) keep.add(position);
    }
  }

  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;
  let lastKept = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (!keep.has(index)) continue;
    const line = lines[index]!;
    if (!current || index !== lastKept + 1) {
      current = {
        oldStart: line.oldNumber ?? previousNumber(lines, index, "oldNumber") + 1,
        newStart: line.newNumber ?? previousNumber(lines, index, "newNumber") + 1,
        lines: [],
        skippedBefore: index - (lastKept + 1)
      };
      hunks.push(current);
    }
    current.lines.push(line);
    lastKept = index;
  }
  return { hunks, additions, deletions, approximate };
}

function previousNumber(lines: DiffLine[], index: number, key: "oldNumber" | "newNumber"): number {
  for (let position = index - 1; position >= 0; position -= 1) {
    const value = lines[position]![key];
    if (value !== undefined) return value;
  }
  return 0;
}

/** Myers' shortest edit script: "=" keep, "-" delete from a, "+" insert from b. */
function myers(a: string[], b: string[]): Array<"=" | "-" | "+"> | undefined {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= Math.min(max, maxEditDistance); d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!;
      } else {
        x = v[offset + k - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, a.length, b.length, offset, d);
      }
    }
  }
  return undefined;
}

function backtrack(trace: Int32Array[], n: number, m: number, offset: number, depth: number): Array<"=" | "-" | "+"> {
  const script: Array<"=" | "-" | "+"> = [];
  let x = n;
  let y = m;
  for (let d = depth; d > 0; d -= 1) {
    const v = trace[d]!;
    const k = x - y;
    const previousK = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
    const previousX = v[offset + previousK]!;
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      script.push("=");
      x -= 1;
      y -= 1;
    }
    script.push(x === previousX ? "+" : "-");
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    script.push("=");
    x -= 1;
    y -= 1;
  }
  return script.reverse();
}

/** A unified-diff patch text, for copying or downloading a patch that cannot be submitted. */
export function unifiedPatch(files: Array<{ path: string; before: string; after: string; added: boolean }>): string {
  return files
    .map((file) => {
      const diff = diffFile(file.before, file.after);
      const header = [
        `diff --git a/${file.path} b/${file.path}`,
        ...(file.added ? ["new file mode 100644", "--- /dev/null"] : [`--- a/${file.path}`]),
        `+++ b/${file.path}`
      ];
      const body = diff.hunks.map((hunk) => {
        const oldCount = hunk.lines.filter((line) => line.kind !== "added").length;
        const newCount = hunk.lines.filter((line) => line.kind !== "removed").length;
        const oldStart = oldCount === 0 ? hunk.oldStart - 1 : hunk.oldStart;
        return [
          `@@ -${oldStart},${oldCount} +${hunk.newStart},${newCount} @@`,
          ...hunk.lines.map((line) => `${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}${line.text}`)
        ].join("\n");
      });
      return [...header, ...body].join("\n");
    })
    .join("\n") + "\n";
}
