/**
 * Dev-only headless test for the triage component. Verifies rendering width
 * safety and the selection key semantics without a terminal.
 *
 *   node scripts/dev-triage.ts
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Feedback } from "../src/types.ts";
import {
  ReviewTriageComponent,
  type TriageEntry,
  type TriageResult,
} from "../src/ui/triage.ts";

// A minimal stand-in theme: real ANSI coloring is unnecessary, and identity
// styling keeps assertions readable.
const identity = (text: string): string => text;
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: identity,
  italic: identity,
  underline: identity,
  inverse: identity,
  strikethrough: identity,
} as unknown as Theme;

const items: Feedback[] = [
  {
    kind: "inline",
    id: "inline:1",
    path: "README.md",
    line: 3,
    originalLine: 3,
    outdated: false,
    diffHunk: "@@ -0,0 +1,3 @@\n+# PGP - Pi Github Prs",
    comments: [
      { id: 1, author: "AlbinLind", body: "Test comment", createdAt: "2026-09-14T19:53:08Z", isReply: false },
      { id: 2, author: "reviewer", body: "A reply", createdAt: "2026-09-14T19:53:23Z", isReply: true },
    ],
  },
  {
    kind: "inline",
    id: "inline:2",
    path: "README.md",
    line: null,
    originalLine: 5,
    outdated: true,
    diffHunk: "@@ -0,0 +1,5 @@\n+# PGP - Pi Github Prs",
    comments: [
      {
        id: 3,
        author: "AlbinLind",
        body: "Comment on something that will be gone",
        createdAt: "2026-09-14T19:53:51Z",
        isReply: false,
      },
    ],
  },
  {
    kind: "review",
    id: "review:1",
    state: "COMMENTED",
    author: "AlbinLind",
    body: "Summary of review",
    submittedAt: "2026-09-14T19:55:25Z",
  },
  {
    kind: "issue",
    id: "issue:1",
    author: "AlbinLind",
    body: "A normal comment",
    createdAt: "2026-09-14T19:55:41Z",
  },
];

let failures = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}`);
  }
}

function makeComponent(currentUser: string | undefined) {
  const entries: TriageEntry[] = items.map((item) => ({
    item,
    selected: !(item.kind === "inline" && item.outdated),
    includeDiff: false,
  }));
  let result: TriageResult = undefined;
  const component = new ReviewTriageComponent({
    title: 'AlbinLind/pgp#1 "add readme"',
    entries,
    currentUser,
    theme,
    maxListRows: 10,
    maxPreviewLines: 8,
    requestRender: () => {},
    onDone: (value) => {
      result = value;
    },
  });
  return { component, entries, getResult: () => result };
}

// --- rendering ---------------------------------------------------------------
{
  const { component } = makeComponent("AlbinLind");
  for (const width of [120, 100, 80, 60, 40, 20]) {
    const lines = component.render(width);
    const tooWide = lines.filter((line) => visibleWidth(line) > width);
    check(`render width ${width}: ${lines.length} lines, none overflow`, tooWide.length === 0);
  }
  console.log("\n--- sample render (width 100) ---");
  for (const line of component.render(100)) {
    console.log(line);
  }
  console.log("--- end render ---\n");
}

// --- default selection -------------------------------------------------------
{
  const { entries } = makeComponent("AlbinLind");
  check("default: inline selected", entries[0].selected);
  check("default: outdated deselected", !entries[1].selected);
  check("default: review selected", entries[2].selected);
  check("default: issue selected", entries[3].selected);
}

// --- d toggles diff only for inline -----------------------------------------
{
  const { component, entries } = makeComponent("AlbinLind");
  component.handleInput("d");
  check("d on inline turns diff on", entries[0].includeDiff);
  component.handleInput("d");
  check("d again turns diff off", !entries[0].includeDiff);
  component.handleInput("j"); // move to outdated inline
  component.handleInput("j"); // move to review
  component.handleInput("d");
  check("d on non-inline does nothing", !entries[2].includeDiff);
  check("d on non-inline shows notice", component.render(80).some((l) => l.includes("only apply to inline")));
}

// --- uppercase via shift and legacy input -----------------------------------
{
  const { component, entries } = makeComponent("AlbinLind");
  component.handleInput("R"); // legacy uppercase
  check("R legacy selects only review", entries[0].selected && entries[2].selected && !entries[3].selected);
  component.handleInput("\x1b[99;2u"); // Kitty shift+c
  check("shift+c CSI-u selects only comments", !entries[0].selected && entries[3].selected);
}

// --- bulk keys ---------------------------------------------------------------
{
  const { component, entries } = makeComponent("AlbinLind");
  component.handleInput("a");
  component.handleInput("a");
  check("a deselects all when all selected", entries.every((entry) => !entry.selected));
  component.handleInput("a");
  check("a selects all when not all selected", entries.every((entry) => entry.selected));

  component.handleInput(" ");
  check("space toggles cursor item off", !entries[0].selected);

  component.handleInput("c");
  check("c adds comments to selection", entries[3].selected && !entries[0].selected);

  component.handleInput("C");
  check("C selects only comments", entries[3].selected && !entries[0].selected && !entries[2].selected);

  component.handleInput("r");
  check("r adds reviews to selection", entries[0].selected && entries[2].selected && entries[3].selected);

  component.handleInput("R");
  check("R selects only reviews", entries[0].selected && entries[2].selected && !entries[3].selected);

  component.handleInput("u");
  check("u adds mine (all here), keeps others", entries[0].selected && entries[1].selected && entries[2].selected && entries[3].selected);

  component.handleInput("space"); // deselect cursor (inline 1)
  component.handleInput("U");
  check("U selects only mine", entries[0].selected && entries[1].selected && entries[2].selected && entries[3].selected);
}

// --- bulk mine with unknown user --------------------------------------------
{
  const { component, entries } = makeComponent(undefined);
  entries.forEach((entry) => (entry.selected = false));
  component.handleInput("u");
  check("u without current user changes nothing", entries.every((entry) => !entry.selected));
  check("u without current user shows notice", component.render(80).some((l) => l.includes("user unknown")));
}

// --- confirm / cancel --------------------------------------------------------
{
  const { component, getResult } = makeComponent("AlbinLind");
  component.handleInput("R");
  component.handleInput("\r");
  const result = getResult();
  // "review" covers both inline threads (including the outdated one) and the
  // review summary, so R selects 3 of the 4 items here.
  check("enter returns selected items", Array.isArray(result) && result.length === 3);
  check("enter preserves includeDiff", result !== null && result.every((entry) => entry.includeDiff === false));

  const { component: c2, getResult: g2 } = makeComponent("AlbinLind");
  c2.handleInput("\x1b");
  check("escape returns null", g2() === null);

  const { component: c3, getResult: g3 } = makeComponent("AlbinLind");
  c3.handleInput("a"); // select all (the outdated item starts deselected)
  c3.handleInput("a"); // deselect all
  c3.handleInput("\r");
  check("enter with empty selection does not finish", g3() === undefined);
}

console.log(failures === 0 ? "\nAll triage checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
