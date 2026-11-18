import type { RunDiffHunk } from "@launchpad/shared";

// A line diff with positions, in bounded time. Reorders, duplicate lines and
// edits anywhere in a file are visible because this compares line sequences,
// not sets of lines.
//
// Common leading and trailing lines are trimmed, then Myers' O((N+M)D)
// algorithm runs on the middle with a limit on edit distance and on work. When
// a limit is reached it does not give up: the whole middle region becomes one
// replacement (every old line removed, every new line added). That diff is
// coarser than a minimal one but still exact, so no change is ever hidden by a
// budget, only shown with less precision.

type Op = { kind: "=" | "-" | "+"; oldIndex: number; newIndex: number };

export interface LineDiffOptions {
  context: number;
  /** Most edit operations Myers searches for before using the coarse replacement. */
  maxEdits?: number;
  /** Most work units (comparisons and steps) before using the coarse replacement. */
  maxWork?: number;
}

export interface LineDiff {
  hunks: RunDiffHunk[];
  /** True when the coarse replacement was used for the middle region. */
  coarse: boolean;
}

/** Split text into lines. A trailing newline yields a final empty line on both sides, so a change to it shows. */
export function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

export function diffLines(oldLines: readonly string[], newLines: readonly string[], options: LineDiffOptions): LineDiff {
  const n = oldLines.length;
  const m = newLines.length;
  let prefix = 0;
  while (prefix < n && prefix < m && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && oldLines[n - 1 - suffix] === newLines[m - 1 - suffix]) suffix += 1;

  const a = oldLines.slice(prefix, n - suffix);
  const b = newLines.slice(prefix, m - suffix);
  let middle = myers(a, b, options.maxEdits ?? 1_500, options.maxWork ?? 20_000_000);
  const coarse = middle === null;
  if (middle === null) {
    middle = [
      ...a.map((_, index) => ({ kind: "-" as const, oldIndex: index, newIndex: -1 })),
      ...b.map((_, index) => ({ kind: "+" as const, oldIndex: -1, newIndex: index })),
    ];
  }

  const ops: Op[] = [];
  for (let index = 0; index < prefix; index += 1) ops.push({ kind: "=", oldIndex: index, newIndex: index });
  for (const op of middle) {
    ops.push({
      kind: op.kind,
      oldIndex: op.oldIndex < 0 ? -1 : op.oldIndex + prefix,
      newIndex: op.newIndex < 0 ? -1 : op.newIndex + prefix,
    });
  }
  for (let index = 0; index < suffix; index += 1) ops.push({ kind: "=", oldIndex: n - suffix + index, newIndex: m - suffix + index });

  return { hunks: hunksOf(ops, oldLines, newLines, options.context), coarse };
}

/** Myers' greedy forward search with a saved frontier per step for backtracking. Null when a limit is reached. */
function myers(a: readonly string[], b: readonly string[], maxEdits: number, maxWork: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((_, index) => ({ kind: "+", oldIndex: -1, newIndex: index }));
  if (m === 0) return a.map((_, index) => ({ kind: "-", oldIndex: index, newIndex: -1 }));
  const limit = Math.min(n + m, maxEdits);
  const offset = limit + 1;
  const frontier = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let work = 0;
  for (let d = 0; d <= limit; d += 1) {
    trace.push(frontier.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && frontier[offset + k - 1]! < frontier[offset + k + 1]!)
        ? frontier[offset + k + 1]!
        : frontier[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
        work += 1;
      }
      work += 1;
      frontier[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a.length, b.length);
    }
    if (work > maxWork) return null;
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number): Op[] {
  const reversed: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const saved = trace[d]!;
    // `saved` holds frontier[k] for k in [-d-1, d+1] at index k + d + 1.
    const at = (k: number) => saved[k + d + 1]!;
    const k = x - y;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = d === 0 ? 0 : at(previousK);
    const previousY = d === 0 ? 0 : previousX - previousK;
    while (x > previousX && y > previousY) {
      reversed.push({ kind: "=", oldIndex: x - 1, newIndex: y - 1 });
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      if (x === previousX) reversed.push({ kind: "+", oldIndex: -1, newIndex: y - 1 });
      else reversed.push({ kind: "-", oldIndex: x - 1, newIndex: -1 });
    }
    x = previousX;
    y = previousY;
  }
  return reversed.reverse();
}

function hunksOf(ops: Op[], oldLines: readonly string[], newLines: readonly string[], context: number): RunDiffHunk[] {
  const changes: number[] = [];
  ops.forEach((op, index) => {
    if (op.kind !== "=") changes.push(index);
  });
  if (changes.length === 0) return [];

  // Old and new lines before each op, for hunk positions.
  const oldBefore = new Int32Array(ops.length + 1);
  const newBefore = new Int32Array(ops.length + 1);
  ops.forEach((op, index) => {
    oldBefore[index + 1] = oldBefore[index]! + (op.kind === "+" ? 0 : 1);
    newBefore[index + 1] = newBefore[index]! + (op.kind === "-" ? 0 : 1);
  });

  const groups: Array<[number, number]> = [];
  let start = changes[0]!;
  let end = start;
  for (const index of changes.slice(1)) {
    if (index - end - 1 <= 2 * context) end = index;
    else {
      groups.push([start, end]);
      start = index;
      end = index;
    }
  }
  groups.push([start, end]);

  return groups.map(([first, last]) => {
    const from = Math.max(0, first - context);
    const to = Math.min(ops.length - 1, last + context);
    const lines: string[] = [];
    for (let index = from; index <= to; index += 1) {
      const op = ops[index]!;
      lines.push(op.kind === "+" ? `+${newLines[op.newIndex]}` : op.kind === "-" ? `-${oldLines[op.oldIndex]}` : ` ${oldLines[op.oldIndex]}`);
    }
    const oldCount = oldBefore[to + 1]! - oldBefore[from]!;
    const newCount = newBefore[to + 1]! - newBefore[from]!;
    return {
      // Unified-diff convention: a side with no lines names the line before it.
      oldStart: oldCount === 0 ? oldBefore[from]! : oldBefore[from]! + 1,
      oldLines: oldCount,
      newStart: newCount === 0 ? newBefore[from]! : newBefore[from]! + 1,
      newLines: newCount,
      text: lines.join("\n"),
    };
  });
}
