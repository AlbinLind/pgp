/**
 * Dev-only unit test for the diff-hunk slicer.
 *
 *   node scripts/dev-diff.ts
 */

import { sliceDiffHunk } from "../src/diff.ts";
import type { InlineThread } from "../src/types.ts";

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ""}`);
  }
}

function makeInline(overrides: Partial<InlineThread> = {}): InlineThread {
  return {
    kind: "inline",
    id: "inline:1",
    path: "file.ts",
    line: null,
    originalLine: null,
    startLine: null,
    originalStartLine: null,
    anchorLine: null,
    anchorStartLine: null,
    side: "RIGHT",
    outdated: false,
    diffHunk: "",
    comments: [],
    ...overrides,
  };
}

const HUNK = [
  "@@ -1,10 +1,11 @@",
  " line1",
  "-line2old",
  "+line2new",
  " line3",
  " line4",
  " line5",
  " line6",
  " line7",
  "-removed8",
  "+added8",
  " line9",
  " line10",
].join("\n");

// --- RIGHT anchor, mid-hunk --------------------------------------------------
{
  const item = makeInline({ diffHunk: HUNK, originalLine: 5, side: "RIGHT" });
  const slice = sliceDiffHunk(item, 1);
  check("right: trim ends", slice.trimmed && slice.elidedBefore === 4 && slice.elidedAfter === 5);
  check("right: total rows", slice.totalRows === 12);
  check(
    "right: recomputed header and rows",
    slice.lines.join("\n") === ["@@ -4,3 +4,3 @@", " line4", " line5", " line6"].join("\n"),
    slice.lines.join("\n"),
  );
}

// --- LEFT anchor (deletion) --------------------------------------------------
{
  const item = makeInline({ diffHunk: HUNK, originalLine: 8, side: "LEFT" });
  const slice = sliceDiffHunk(item, 1);
  check(
    "left: keeps the removed line",
    slice.lines.join("\n") ===
      ["@@ -7,2 +7,2 @@", " line7", "-removed8", "+added8"].join("\n"),
    slice.lines.join("\n"),
  );
}

// --- multi-line range --------------------------------------------------------
{
  const item = makeInline({
    diffHunk: HUNK,
    originalLine: 6,
    originalStartLine: 4,
    side: "RIGHT",
  });
  const slice = sliceDiffHunk(item, 1);
  check(
    "range: covers start..end plus context",
    slice.lines.join("\n") ===
      ["@@ -3,5 +3,5 @@", " line3", " line4", " line5", " line6", " line7"].join("\n"),
    slice.lines.join("\n"),
  );
}

// --- header without counts ---------------------------------------------------
{
  const hunk = ["@@ -5 +5 @@", "-old", "+new"].join("\n");
  const item = makeInline({ diffHunk: hunk, originalLine: 5, side: "LEFT" });
  const slice = sliceDiffHunk(item, 1);
  check("short header: round-trips", slice.lines.join("\n") === hunk, slice.lines.join("\n"));
  check("short header: not trimmed", !slice.trimmed);
}

// --- context clamping at the top/bottom --------------------------------------
{
  const item = makeInline({ diffHunk: HUNK, originalLine: 1, side: "RIGHT" });
  const slice = sliceDiffHunk(item, 3);
  check("top clamp: nothing elided before", slice.elidedBefore === 0 && slice.trimmed);
  check(
    "top clamp: header start preserved",
    slice.lines[0] === "@@ -1,3 +1,3 @@" && slice.lines.length === 5,
    slice.lines.join("\n"),
  );
}

// --- no-newline marker -------------------------------------------------------
{
  const hunk = ["@@ -1 +1 @@", "-old", "+new", "\\ No newline at end of file"].join("\n");
  const item = makeInline({ diffHunk: hunk, originalLine: 1, side: "RIGHT" });
  const slice = sliceDiffHunk(item, 1);
  check(
    "no-newline: marker stays attached",
    slice.lines.join("\n") === hunk,
    slice.lines.join("\n"),
  );
}

// --- fallbacks ---------------------------------------------------------------
{
  const item = makeInline({ diffHunk: HUNK, originalLine: 999, side: "RIGHT" });
  const slice = sliceDiffHunk(item, 1);
  check("missing anchor: falls back to full hunk", !slice.trimmed && slice.lines.length === 13);

  const noHeader = makeInline({ diffHunk: "not a hunk", originalLine: 1 });
  check("missing header: falls back", !sliceDiffHunk(noHeader, 1).trimmed);

  const empty = makeInline({ diffHunk: "" });
  check("empty hunk: returns nothing", sliceDiffHunk(empty, 3).lines.length === 0);
}

// --- current-line fallback when original_line is absent ----------------------
{
  const item = makeInline({ diffHunk: HUNK, line: 3, originalLine: null, side: "RIGHT" });
  const slice = sliceDiffHunk(item, 1);
  check(
    "line fallback: anchors on current line",
    slice.lines.some((line) => line === " line3"),
    slice.lines.join("\n"),
  );
}

console.log(failures === 0 ? "\nAll diff checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
