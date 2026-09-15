/**
 * Dev-only unit test for PR patch parsing plus the full-hunk resolution that
 * works around GitHub truncating `diff_hunk` at the commented line.
 *
 *   node scripts/dev-patch.ts
 */

import { sliceDiffHunk } from "../src/diff.ts";
import { normalizeFeedback } from "../src/github.ts";
import {
  buildPatchHunks,
  findPatchHunk,
  fullHunkForComment,
  parsePatchHunks,
} from "../src/patch.ts";
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

const FULL_PATCH = [
  "@@ -1,5 +1,8 @@",
  " ctx1",
  " ctx2",
  "-old3",
  "+new3",
  " ctx4",
  " ctx5",
  "+new6",
  "+new7",
  "+new8",
  "@@ -20,3 +23,3 @@",
  " other",
  "-old",
  "+new",
].join("\n");

// The API returns only the hunk prefix up to the commented line.
const TRUNCATED = ["@@ -1,5 +1,8 @@", " ctx1", " ctx2", "-old3", "+new3"].join("\n");

// --- parsing -----------------------------------------------------------------
{
  const hunks = parsePatchHunks(FULL_PATCH);
  check("parse: finds both hunks", hunks.length === 2);
  check("parse: first hunk keeps body", hunks[0]?.lines.length === 10);
  check("parse: first hunk ranges", hunks[0]?.header.newStart === 1 && hunks[0]?.header.newCount === 8);
  check("parse: second hunk ranges", hunks[1]?.header.oldStart === 20 && hunks[1]?.header.newCount === 3);
  check("parse: empty patch", parsePatchHunks(null).length === 0);
}

// --- lookup ------------------------------------------------------------------
{
  const hunks = parsePatchHunks(FULL_PATCH);
  check("find: right line inside first hunk", findPatchHunk(hunks, "RIGHT", 3)?.header.newStart === 1);
  check("find: right line inside second hunk", findPatchHunk(hunks, "RIGHT", 24)?.header.newStart === 23);
  check("find: right line outside hunks", findPatchHunk(hunks, "RIGHT", 100) === undefined);
  check("find: left line inside first hunk", findPatchHunk(hunks, "LEFT", 3)?.header.oldStart === 1);
  check("fullHunk: outdated line is skipped", fullHunkForComment(hunks, "RIGHT", null) === undefined);
}

// --- map builder -------------------------------------------------------------
{
  const map = buildPatchHunks([
    { filename: "a.ts", patch: FULL_PATCH },
    { filename: "binary.png", patch: null },
  ]);
  check("map: keeps patched file", map.has("a.ts"));
  check("map: skips patchless file", !map.has("binary.png"));
}

// --- end-to-end: truncated comment + full patch ------------------------------
{
  const comment = {
    id: 1,
    body: "please change this",
    path: "file.ts",
    line: 3,
    original_line: 3,
    start_line: null,
    original_start_line: null,
    side: "RIGHT" as const,
    diff_hunk: TRUNCATED,
    in_reply_to_id: null,
    user: { login: "alice" },
    created_at: "2026-01-01T00:00:00Z",
  };
  const [thread] = normalizeFeedback(
    [comment],
    [],
    [],
    buildPatchHunks([{ filename: "file.ts", patch: FULL_PATCH }]),
  ) as InlineThread[];

  check("e2e: keeps the comment line", thread?.line === 3);
  check("e2e: anchor points at the comment", thread?.anchorLine === 3);
  check("e2e: hunk is no longer truncated", thread?.diffHunk.split("\n").length === 10);
  check(
    "e2e: hunk now has trailing context",
    thread?.diffHunk.includes("+new8") === true,
    thread?.diffHunk,
  );

  const slice = sliceDiffHunk(thread, 2);
  check(
    "e2e: slice shows context after the comment",
    slice.lines.includes(" ctx4") && slice.lines.includes(" ctx5"),
    slice.lines.join("\n"),
  );
}

// --- outdated comments keep their historical hunk -----------------------------
{
  const comment = {
    id: 2,
    body: "old",
    path: "file.ts",
    line: null,
    original_line: 3,
    start_line: null,
    original_start_line: null,
    side: "RIGHT" as const,
    diff_hunk: TRUNCATED,
    in_reply_to_id: null,
    user: { login: "alice" },
    created_at: "2026-01-01T00:00:00Z",
  };
  const [thread] = normalizeFeedback(
    [comment],
    [],
    [],
    buildPatchHunks([{ filename: "file.ts", patch: FULL_PATCH }]),
  ) as InlineThread[];
  check("outdated: keeps API hunk", thread?.diffHunk === TRUNCATED);
  check("outdated: anchors on the original line", thread?.anchorLine === 3);
}

console.log(failures === 0 ? "\nAll patch checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
