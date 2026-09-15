/**
 * GitHub PR file patches.
 *
 * The per-comment `diff_hunk` returned by the REST API is truncated to end at
 * the commented line, so it never contains trailing context. The PR files
 * endpoint returns the full patch per file, which we parse into hunks and use
 * to replace the truncated hunk for active comments.
 *
 * Pure helpers: no pi/TUI dependencies.
 */

import { type HunkHeader, parseHunkHeader } from "./diff.ts";
import type { DiffSide } from "./types.ts";

export interface PatchHunk {
  header: HunkHeader;
  /** The `@@` header line followed by the body rows. */
  lines: string[];
}

/** Minimal shape of a `/pulls/{n}/files` entry. */
export interface PatchFile {
  filename: string;
  patch?: string | null;
}

/** Split a unified-diff patch into its hunks. */
export function parsePatchHunks(patch: string | null | undefined): PatchHunk[] {
  if (!patch) {
    return [];
  }
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | undefined;
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("@@")) {
      const header = parseHunkHeader(line);
      current = header ? { header, lines: [line] } : undefined;
      if (current) {
        hunks.push(current);
      }
    } else if (current) {
      current.lines.push(line);
    }
  }
  return hunks;
}

/** Map each file in a PR to its parsed hunks. */
export function buildPatchHunks(files: PatchFile[]): Map<string, PatchHunk[]> {
  const map = new Map<string, PatchHunk[]>();
  for (const file of files) {
    const hunks = parsePatchHunks(file.patch);
    if (hunks.length > 0) {
      map.set(file.filename, hunks);
    }
  }
  return map;
}

/**
 * Find the hunk in `hunks` that contains `line` on the given side. `count` is
 * inclusive-start/exclusive-end, so a pure insertion/deletion (count 0) has no
 * lines on the empty side.
 */
export function findPatchHunk(
  hunks: PatchHunk[] | undefined,
  side: DiffSide,
  line: number,
): PatchHunk | undefined {
  if (!hunks) {
    return undefined;
  }
  for (const hunk of hunks) {
    const start = side === "LEFT" ? hunk.header.oldStart : hunk.header.newStart;
    const count = side === "LEFT" ? hunk.header.oldCount : hunk.header.newCount;
    if (count > 0 && line >= start && line < start + count) {
      return hunk;
    }
  }
  return undefined;
}

/**
 * Resolve the full hunk for an inline comment. Uses the current line when the
 * comment is active (the current patch is authoritative); returns `undefined`
 * when the line is outdated or the file has no patch.
 */
export function fullHunkForComment(
  hunks: PatchHunk[] | undefined,
  side: DiffSide,
  line: number | null,
): PatchHunk | undefined {
  if (line === null) {
    return undefined;
  }
  return findPatchHunk(hunks, side, line);
}
