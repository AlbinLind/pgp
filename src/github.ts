/**
 * GitHub access layer.
 *
 * READ-ONLY GUARDRAIL: this extension never writes to GitHub. Every function
 * here issues GET-style `gh` reads (`gh pr view`, `gh repo view`, `gh api`
 * without `--method`). Do not add POST/PATCH/PUT/DELETE calls, `gh pr comment`,
 * `gh api --method`, or anything that mutates the PR.
 */

import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import type {
  Feedback,
  InlineThread,
  IssueComment,
  PullFeedback,
  PullRequestRef,
  ReviewState,
  ReviewSummary,
  ThreadComment,
} from "./types.ts";

/** Minimal execution surface the GitHub layer depends on (pi.exec). */
export type GhExecutor = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

const API_HEADERS = [
  "-H",
  "Accept: application/vnd.github+json",
  "-H",
  "X-GitHub-Api-Version: 2022-11-28",
];

const DEFAULT_TIMEOUT_MS = 30_000;

export class GitHubError extends Error {
  readonly detail?: string;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = "GitHubError";
    this.detail = detail;
  }
}

interface RawReviewComment {
  id: number;
  body: string | null;
  path: string;
  line: number | null;
  original_line: number | null;
  start_line?: number | null;
  original_start_line?: number | null;
  side?: "LEFT" | "RIGHT" | null;
  start_side?: "LEFT" | "RIGHT" | null;
  diff_hunk: string | null;
  in_reply_to_id: number | null;
  user: { login: string } | null;
  created_at: string;
}

interface RawReview {
  id: number;
  body: string | null;
  state: string;
  user: { login: string } | null;
  submitted_at: string | null;
}

interface RawIssueComment {
  id: number;
  body: string | null;
  user: { login: string } | null;
  created_at: string;
}

interface RawPullRef {
  number: number;
  title: string;
  url: string;
  state: string;
  headRefName: string;
  baseRefName: string;
}

async function runGh(
  exec: GhExecutor,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const result = await exec("gh", args, { cwd, signal, timeout });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new GitHubError(`gh ${args[0] ?? ""} failed`, detail);
  }
  return result.stdout;
}

export async function assertGhAvailable(
  exec: GhExecutor,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const result = await exec("gh", ["--version"], { cwd, signal, timeout: 10_000 });
  if (result.code !== 0) {
    throw new GitHubError(
      "GitHub CLI (gh) is not installed or not on PATH",
      "Install it from https://cli.github.com/ and run `gh auth login`",
    );
  }
}

/** Add actionable hints to common gh failures. */
function classifyGhError(error: unknown, prNumber: number | undefined): unknown {
  if (!(error instanceof GitHubError)) {
    return error;
  }
  const detail = error.detail ?? "";
  if (/not a git repository/i.test(detail)) {
    return new GitHubError("Not inside a git repository", detail);
  }
  if (/no (open )?pull requests? found|Could not resolve to a PullRequest/i.test(detail)) {
    return prNumber === undefined
      ? new GitHubError(
          "No PR found for the current branch",
          `${detail}\nPass a PR number explicitly, e.g. /pr-review 123`,
        )
      : new GitHubError(`PR #${prNumber} not found`, detail);
  }
  if (/authentication|not logged in|gh auth login|bad credentials|HTTP 401/i.test(detail)) {
    return new GitHubError(
      "GitHub authentication failed",
      `${detail}\nRun \`gh auth login\` and try again`,
    );
  }
  if (/rate limit/i.test(detail)) {
    return new GitHubError(
      "GitHub API rate limit exceeded",
      `${detail}\nWait a bit and try again`,
    );
  }
  return error;
}

function parseRepoFromPrUrl(prUrl: string): { owner: string; repo: string } {
  let segments: string[] = [];
  try {
    segments = new URL(prUrl).pathname.split("/").filter(Boolean);
  } catch {
    segments = [];
  }
  const owner = segments[0];
  const repo = segments[1];
  if (!owner || !repo) {
    throw new GitHubError("Could not determine owner/repo", `unexpected PR url: ${prUrl}`);
  }
  return { owner, repo };
}

export async function resolvePullRequest(
  exec: GhExecutor,
  cwd: string,
  prNumber: number | undefined,
  signal: AbortSignal | undefined,
): Promise<PullRequestRef> {
  const args = ["pr", "view"];
  if (prNumber !== undefined) {
    args.push(String(prNumber));
  }
  args.push("--json", "number,title,url,state,headRefName,baseRefName");

  const stdout = await runGh(exec, args, cwd, signal);
  let raw: RawPullRef;
  try {
    raw = JSON.parse(stdout) as RawPullRef;
  } catch {
    throw new GitHubError("Could not parse gh pr view output", stdout.slice(0, 200));
  }

  const { owner, repo } = parseRepoFromPrUrl(raw.url);
  return {
    owner,
    repo,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    state: raw.state,
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
  };
}

export async function getAuthenticatedUser(
  exec: GhExecutor,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  try {
    const stdout = await runGh(exec, ["api", "user", "--jq", ".login"], cwd, signal, 10_000);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run a list endpoint with full pagination. `--paginate --slurp` returns an
 * array of page arrays; flatten it into a single item list.
 */
async function ghApiList(
  exec: GhExecutor,
  cwd: string,
  path: string,
  signal: AbortSignal | undefined,
): Promise<unknown[]> {
  const stdout = await runGh(
    exec,
    ["api", ...API_HEADERS, "--paginate", "--slurp", path],
    cwd,
    signal,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new GitHubError(`Could not parse gh api response for ${path}`, stdout.slice(0, 200));
  }
  if (!Array.isArray(parsed)) {
    throw new GitHubError(
      `Unexpected gh api response for ${path}`,
      `expected array of pages, got ${typeof parsed}`,
    );
  }

  const items: unknown[] = [];
  for (const page of parsed) {
    if (Array.isArray(page)) {
      items.push(...page);
    } else if (page != null) {
      items.push(page);
    }
  }
  return items;
}

export async function fetchPullFeedback(
  exec: GhExecutor,
  cwd: string,
  prNumber: number | undefined,
  signal: AbortSignal | undefined,
): Promise<PullFeedback> {
  await assertGhAvailable(exec, cwd, signal);

  try {
    const pr = await resolvePullRequest(exec, cwd, prNumber, signal);
    const base = `/repos/${pr.owner}/${pr.repo}`;

    const [comments, reviews, issueComments, currentUser] = await Promise.all([
      ghApiList(exec, cwd, `${base}/pulls/${pr.number}/comments`, signal),
      ghApiList(exec, cwd, `${base}/pulls/${pr.number}/reviews`, signal),
      ghApiList(exec, cwd, `${base}/issues/${pr.number}/comments`, signal),
      getAuthenticatedUser(exec, cwd, signal),
    ]);

    const items = normalizeFeedback(
      comments as RawReviewComment[],
      reviews as RawReview[],
      issueComments as RawIssueComment[],
    );

    return { pr, items, currentUser };
  } catch (error) {
    throw classifyGhError(error, prNumber);
  }
}

export function normalizeFeedback(
  comments: RawReviewComment[],
  reviews: RawReview[],
  issueComments: RawIssueComment[],
): Feedback[] {
  return [
    ...buildInlineThreads(comments),
    ...buildReviewSummaries(reviews),
    ...buildIssueComments(issueComments),
  ];
}

function toThreadComment(comment: RawReviewComment): ThreadComment {
  return {
    id: comment.id,
    author: comment.user?.login ?? "ghost",
    body: (comment.body ?? "").trim(),
    createdAt: comment.created_at,
    isReply: comment.in_reply_to_id != null,
  };
}

function buildInlineThreads(comments: RawReviewComment[]): InlineThread[] {
  const byId = new Map<number, RawReviewComment>();
  for (const comment of comments) {
    byId.set(comment.id, comment);
  }

  // Resolve the topmost ancestor of a reply chain, guarding against cycles and
  // dangling `in_reply_to_id` references.
  const rootIdFor = (comment: RawReviewComment): number => {
    let current = comment;
    const seen = new Set<number>([comment.id]);
    while (current.in_reply_to_id != null) {
      const parent = byId.get(current.in_reply_to_id);
      if (!parent || seen.has(parent.id)) {
        break;
      }
      seen.add(parent.id);
      current = parent;
    }
    return current.id;
  };

  const groups = new Map<number, RawReviewComment[]>();
  for (const comment of comments) {
    const rootId = rootIdFor(comment);
    const group = groups.get(rootId);
    if (group) {
      group.push(comment);
    } else {
      groups.set(rootId, [comment]);
    }
  }

  const threads: InlineThread[] = [];
  for (const [rootId, group] of groups) {
    const root = byId.get(rootId) ?? group[0];
    const replies = group
      .filter((comment) => comment.id !== root.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const ordered = [root, ...replies];

    threads.push({
      kind: "inline",
      id: `inline:${rootId}`,
      path: root.path,
      line: root.line ?? null,
      originalLine: root.original_line ?? null,
      startLine: root.start_line ?? null,
      originalStartLine: root.original_start_line ?? null,
      side: root.side === "LEFT" ? "LEFT" : "RIGHT",
      outdated: (root.line ?? null) === null,
      diffHunk: root.diff_hunk ?? "",
      comments: ordered.map(toThreadComment),
    });
  }

  threads.sort((a, b) => {
    const byPath = a.path.localeCompare(b.path);
    if (byPath !== 0) {
      return byPath;
    }
    const aLine = a.line ?? a.originalLine ?? Number.MAX_SAFE_INTEGER;
    const bLine = b.line ?? b.originalLine ?? Number.MAX_SAFE_INTEGER;
    if (aLine !== bLine) {
      return aLine - bLine;
    }
    return (a.comments[0]?.createdAt ?? "").localeCompare(b.comments[0]?.createdAt ?? "");
  });

  return threads;
}

const REVIEW_STATES = new Set<ReviewState>([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
]);

function normalizeReviewState(state: string): ReviewState {
  const upper = state.toUpperCase() as ReviewState;
  return REVIEW_STATES.has(upper) ? upper : "COMMENTED";
}

function buildReviewSummaries(reviews: RawReview[]): ReviewSummary[] {
  return reviews
    .filter((review) => (review.body ?? "").trim().length > 0)
    .map<ReviewSummary>((review) => ({
      kind: "review",
      id: `review:${review.id}`,
      state: normalizeReviewState(review.state),
      author: review.user?.login ?? "ghost",
      body: (review.body ?? "").trim(),
      submittedAt: review.submitted_at ?? "",
    }))
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

function buildIssueComments(comments: RawIssueComment[]): IssueComment[] {
  return comments
    .map<IssueComment>((comment) => ({
      kind: "issue",
      id: `issue:${comment.id}`,
      author: comment.user?.login ?? "ghost",
      body: (comment.body ?? "").trim(),
      createdAt: comment.created_at,
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
