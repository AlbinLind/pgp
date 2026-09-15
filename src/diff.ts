/**
 * Diff-hunk slicing.
 *
 * A stored hunk can be dozens of lines, but for both the triage preview and the
 * agent prompt we only want the slice around the line(s) the comment is
 * anchored to. Note that GitHub's per-comment `diff_hunk` is truncated to end
 * at the comment, so the hunk usually comes from the PR's file patch instead
 * (see `patch.ts`).
 *
 * `sliceDiffHunk` is pure and has no pi/TUI dependencies so it can be unit
 * tested directly.
 */

import type { DiffSide, InlineThread } from "./types.ts";

/** Bounds for the configurable context window (lines on each side). */
export const MIN_DIFF_CONTEXT = 1;
export const MAX_DIFF_CONTEXT = 20;

export interface DiffSlice {
  /** Hunk header + retained body rows, ready to print in order. */
  lines: string[];
  /** True when rows before/after the slice were dropped. */
  trimmed: boolean;
  /** Body rows dropped before the retained slice. */
  elidedBefore: number;
  /** Body rows dropped after the retained slice. */
  elidedAfter: number;
  /** Total body rows in the original hunk (excluding the header). */
  totalRows: number;
  /** Index in `lines` of the first anchor row, or -1 when unknown. */
  anchorStart: number;
  /** Index in `lines` of the last anchor row, or -1 when unknown. */
  anchorEnd: number;
}

/** Parsed `@@ -oldStart,oldCount +newStart,newCount @@` header. */
export interface HunkHeader {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Anything after the closing `@@`, e.g. a section heading. */
  suffix: string;
}

interface Anchor {
  side: DiffSide;
  start: number;
  end: number;
}

export function parseHunkHeader(line: string): HunkHeader | undefined {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
  if (!match) {
    return undefined;
  }
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
    suffix: match[5] ?? "",
  };
}

function formatRange(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}

function formatHunkHeader(header: HunkHeader, oldStart: number, oldCount: number, newStart: number, newCount: number): string {
  return `@@ -${formatRange(oldStart, oldCount)} +${formatRange(newStart, newCount)} @@${header.suffix}`;
}

/**
 * Candidate anchors, most reliable first. `anchorLine` is set during
 * normalization to match the stored hunk; `original_*` is the fallback for the
 * API's truncated hunks (which end at the comment).
 */
function resolveAnchors(item: InlineThread): Anchor[] {
  const side: DiffSide = item.side ?? "RIGHT";
  const anchors: Anchor[] = [];
  const push = (end: number | null | undefined, start: number | null | undefined): void => {
    if (end === null || end === undefined) {
      return;
    }
    const rawStart = start ?? end;
    anchors.push({ side, start: Math.min(rawStart, end), end: Math.max(rawStart, end) });
  };
  push(item.anchorLine, item.anchorStartLine);
  push(item.originalLine, item.originalStartLine);
  push(item.line, item.startLine);
  return anchors;
}

/** `\ No newline at end of file` metadata rows do not advance line counters. */
function isNoNewline(line: string): boolean {
  return line.startsWith("\\");
}

function fullSlice(allLines: string[], totalRows: number): DiffSlice {
  return {
    lines: allLines,
    trimmed: false,
    elidedBefore: 0,
    elidedAfter: 0,
    totalRows,
    anchorStart: -1,
    anchorEnd: -1,
  };
}

/**
 * Return the slice of `item.diffHunk` around the commented line(s), keeping
 * `context` rows on each side. Falls back to the full hunk when the header or
 * anchor cannot be located.
 */
export function sliceDiffHunk(item: InlineThread, context: number): DiffSlice {
  const allLines = item.diffHunk.replace(/\r\n/g, "\n").split("\n");
  while (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }

  const headerIndex = allLines.findIndex((line) => line.startsWith("@@"));
  const header = headerIndex >= 0 ? parseHunkHeader(allLines[headerIndex]) : undefined;
  const anchors = resolveAnchors(item);
  if (!header || anchors.length === 0) {
    return fullSlice(allLines, Math.max(0, allLines.length - 1));
  }

  const body = allLines.slice(headerIndex + 1);
  const oldAt = new Array<number>(body.length).fill(0);
  const newAt = new Array<number>(body.length).fill(0);
  let oldNo = header.oldStart;
  let newNo = header.newStart;
  for (let i = 0; i < body.length; i++) {
    const marker = body[i][0];
    if (marker === "+") {
      newAt[i] = newNo++;
    } else if (marker === "-") {
      oldAt[i] = oldNo++;
    } else if (!isNoNewline(body[i])) {
      oldAt[i] = oldNo++;
      newAt[i] = newNo++;
    }
  }

  let first = -1;
  let last = -1;
  for (const anchor of anchors) {
    const at = anchor.side === "LEFT" ? oldAt : newAt;
    first = -1;
    last = -1;
    for (let i = 0; i < at.length; i++) {
      const lineNo = at[i];
      if (lineNo >= anchor.start && lineNo <= anchor.end) {
        if (first === -1) {
          first = i;
        }
        last = i;
      }
    }
    if (first !== -1) {
      break;
    }
  }
  if (first === -1) {
    return fullSlice(allLines, body.length);
  }

  const span = Math.max(MIN_DIFF_CONTEXT, Math.trunc(context));
  let from = Math.max(0, first - span);
  let to = Math.min(body.length - 1, last + span);
  // Keep `\ No newline` rows attached to the line they annotate.
  while (from > 0 && isNoNewline(body[from])) {
    from--;
  }
  while (to + 1 < body.length && isNoNewline(body[to + 1])) {
    to++;
  }

  let droppedOld = 0;
  let droppedNew = 0;
  for (let i = 0; i < from; i++) {
    const marker = body[i][0];
    if (marker === "+") {
      droppedNew++;
    } else if (marker === "-") {
      droppedOld++;
    } else if (!isNoNewline(body[i])) {
      droppedOld++;
      droppedNew++;
    }
  }

  let keptOld = 0;
  let keptNew = 0;
  for (let i = from; i <= to; i++) {
    const marker = body[i][0];
    if (marker === "+") {
      keptNew++;
    } else if (marker === "-") {
      keptOld++;
    } else if (!isNoNewline(body[i])) {
      keptOld++;
      keptNew++;
    }
  }

  const elidedBefore = from;
  const elidedAfter = body.length - 1 - to;
  return {
    lines: [
      formatHunkHeader(
        header,
        header.oldStart + droppedOld,
        keptOld,
        header.newStart + droppedNew,
        keptNew,
      ),
      ...body.slice(from, to + 1),
    ],
    trimmed: elidedBefore > 0 || elidedAfter > 0,
    elidedBefore,
    elidedAfter,
    totalRows: body.length,
    anchorStart: 1 + (first - from),
    anchorEnd: 1 + (last - from),
  };
}
