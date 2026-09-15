/**
 * Prompt and display helpers for normalized PR feedback.
 */

import type {
  Feedback,
  FeedbackCategory,
  PullRequestRef,
  SelectionEntry,
  SelectionResult,
} from "./types.ts";
import { sliceDiffHunk } from "./diff.ts";

/** All authors associated with an item (a thread may have several). */
export function feedbackAuthors(item: Feedback): string[] {
  if (item.kind === "inline") {
    return [...new Set(item.comments.map((comment) => comment.author))];
  }
  return [item.author];
}

/**
 * Bulk-selection category:
 * - "review": inline diff comments + review summaries
 * - "comment": general PR/issue comments
 */
export function feedbackCategory(item: Feedback): FeedbackCategory {
  return item.kind === "issue" ? "comment" : "review";
}

/** Short location label, e.g. `README.md:3` or `COMMENTED review`. */
export function feedbackLocation(item: Feedback): string {
  switch (item.kind) {
    case "inline": {
      const line = item.line ?? item.originalLine;
      return line != null ? `${item.path}:${line}` : item.path;
    }
    case "review":
      return item.state;
    case "issue":
      return "PR comment";
  }
}

/** Single-line preview of an item's body, for compact list rows. */
export function feedbackPreview(item: Feedback, maxLength = 80): string {
  const body = item.kind === "inline" ? (item.comments[0]?.body ?? "") : item.body;
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLength) {
    return flat;
  }
  return `${flat.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * Build the user message handed to the agent. Always includes kind, path/line,
 * author, and the full comment text. A diff slice is included only for items
 * whose `includeDiff` toggle is on, sized by `diffContext`.
 */
export function buildPrompt(pr: PullRequestRef, selection: SelectionResult): string {
  const lines: string[] = [];

  lines.push(
    `# Address GitHub review feedback — ${pr.owner}/${pr.repo}#${pr.number} "${pr.title}"`,
  );
  lines.push("");
  lines.push(`PR: ${pr.url} (${pr.headRefName} → ${pr.baseRefName})`);
  lines.push("");
  lines.push("For each item below, do ONE of:");
  lines.push("- **Fix it**: make the code change, then briefly say what you changed and why.");
  lines.push(
    "- **Explain it**: if no change is warranted, explain why, referencing the relevant file/code.",
  );
  lines.push("");
  lines.push("Rules:");
  lines.push(
    "- Do NOT post, reply to, resolve, or modify anything on GitHub. This is read-only. Leave the PR untouched.",
  );
  lines.push(
    "- Inline comment line numbers may be outdated or stale. Verify against the current working tree before changing anything; look at the file, not just the quoted hunk.",
  );
  lines.push(
    "- Work through every item and finish with a short per-item summary (fixed / explained).",
  );
  lines.push("");

  selection.forEach((entry, index) => {
    lines.push(...renderItem(entry, index + 1));
    lines.push("");
  });

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderItem(entry: SelectionEntry, index: number): string[] {
  const { item } = entry;
  if (item.kind === "inline") {
    const root = item.comments[0];
    const outdated = item.outdated ? " (outdated)" : "";
    const out = [
      `## ${index}. [inline] ${feedbackLocation(item)}${outdated} — @${root?.author ?? "ghost"}`,
    ];
    if (root) {
      out.push(...quoteBlock(root.body));
    }
    for (const reply of item.comments.slice(1)) {
      out.push(`- ↳ @${reply.author}: ${reply.body.replace(/\n/g, "\n  ")}`);
    }
    if (entry.includeDiff && item.diffHunk.trim()) {
      const slice = sliceDiffHunk(item, entry.diffContext);
      if (slice.trimmed) {
        out.push(
          `_(${entry.diffContext} line(s) of context each side · ${slice.totalRows} diff line(s) total)_`,
        );
      }
      out.push("```diff");
      out.push(...slice.lines);
      out.push("```");
    }
    return out;
  }

  if (item.kind === "review") {
    return [`## ${index}. [review · ${item.state}] @${item.author}`, item.body];
  }

  return [`## ${index}. [PR comment] @${item.author}`, item.body];
}

function quoteBlock(text: string): string[] {
  return text.split("\n").map((line) => `> ${line}`);
}
