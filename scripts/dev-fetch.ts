/**
 * Dev-only smoke test: fetch PR feedback with gh and print the normalized
 * items plus the generated prompt. Run from the repo root:
 *
 *   node scripts/dev-fetch.ts [PR number]
 *
 * This does not load pi; it exercises src/github.ts and src/format.ts directly.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildPrompt,
  feedbackAuthors,
  feedbackLocation,
  feedbackPreview,
} from "../src/format.ts";
import { type GhExecutor, fetchPullFeedback } from "../src/github.ts";

const execFileAsync = promisify(execFile);

const exec: GhExecutor = async (command, args, options) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options?.cwd,
      timeout: options?.timeout,
    });
    return { stdout, stderr, code: 0, killed: false };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(error),
      code: typeof err.code === "number" ? err.code : 1,
      killed: false,
    };
  }
};

const prArg = process.argv[2];
const prNumber = prArg ? Number.parseInt(prArg, 10) : undefined;

const { pr, items, currentUser } = await fetchPullFeedback(
  exec,
  process.cwd(),
  prNumber,
  undefined,
);

console.log(`\nPR: ${pr.owner}/${pr.repo}#${pr.number} "${pr.title}" (${pr.headRefName} → ${pr.baseRefName})`);
console.log(`authenticated as: @${currentUser ?? "unknown"}\n`);

items.forEach((item, index) => {
  const outdated = item.kind === "inline" && item.outdated ? " (outdated)" : "";
  console.log(
    `${String(index + 1).padStart(2, " ")}. [${item.kind}] ${feedbackLocation(item)}${outdated} ${feedbackAuthors(item).map((a) => `@${a}`).join(", ")} — ${feedbackPreview(item)}`,
  );
});

const selection = items
  .filter((item) => !(item.kind === "inline" && item.outdated))
  .map((item) => ({ item, includeDiff: false, diffContext: 3 }));

console.log(`\n=== PROMPT (${selection.length} selected) ===\n`);
console.log(buildPrompt(pr, selection));
