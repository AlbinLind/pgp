/**
 * Shared data model for the PGP (Pi GitHub PRs) extension.
 *
 * Feedback is normalized from three GitHub REST sources into a single
 * discriminated union so the UI and prompt builder can treat every item
 * uniformly.
 */

export type FeedbackKind = "inline" | "review" | "issue";

export interface ThreadComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  isReply: boolean;
}

/** Which side of the diff an inline comment is anchored to. */
export type DiffSide = "LEFT" | "RIGHT";

/** A root inline diff comment plus its replies. */
export interface InlineThread {
  kind: "inline";
  id: string;
  path: string;
  /** Current line, or null when the comment is outdated. */
  line: number | null;
  originalLine: number | null;
  /** First line of a multi-line comment range, when applicable. */
  startLine: number | null;
  originalStartLine: number | null;
  /** Side of the diff the comment is anchored to. */
  side: DiffSide;
  outdated: boolean;
  diffHunk: string;
  /** Root comment first, then replies in chronological order. */
  comments: ThreadComment[];
}

export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";

/** The optional body text attached when a review is submitted. */
export interface ReviewSummary {
  kind: "review";
  id: string;
  state: ReviewState;
  author: string;
  body: string;
  submittedAt: string;
}

/** A general PR conversation comment (GitHub "issue" comments). */
export interface IssueComment {
  kind: "issue";
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export type Feedback = InlineThread | ReviewSummary | IssueComment;

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  state: string;
  headRefName: string;
  baseRefName: string;
}

/** One selected feedback item plus its UI-only diff settings. */
export interface SelectionEntry {
  item: Feedback;
  /** Whether the diff hunk is included for this item. */
  includeDiff: boolean;
  /** Lines of context shown on each side of the commented line when included. */
  diffContext: number;
}

export type SelectionResult = SelectionEntry[];

export interface PullFeedback {
  pr: PullRequestRef;
  items: Feedback[];
  /** Login of the authenticated gh user, when it can be resolved. */
  currentUser?: string;
}

export const REVIEW_CATEGORY = "review" as const;
export const COMMENT_CATEGORY = "comment" as const;
export type FeedbackCategory = typeof REVIEW_CATEGORY | typeof COMMENT_CATEGORY;
