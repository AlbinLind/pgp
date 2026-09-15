/**
 * PGP — Pi GitHub PRs
 *
 * A read-only `/pr-review` command that resolves a PR, fetches all feedback
 * (inline review comments, review summaries, and general PR comments), shows a
 * triage window, and hands the selected items to the agent to fix or explain.
 *
 * The extension only reads from GitHub. It never posts, replies, resolves, or
 * otherwise mutates the PR.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { buildPrompt } from "./format.ts";
import { type GhExecutor, GitHubError, fetchPullFeedback } from "./github.ts";
import type { PullFeedback, SelectionEntry } from "./types.ts";
import { ReviewTriageComponent, type TriageEntry } from "./ui/triage.ts";

function notifyError(ctx: ExtensionCommandContext, error: unknown): void {
  if (error instanceof GitHubError) {
    ctx.ui.notify(`${error.message}${error.detail ? `: ${error.detail}` : ""}`, "error");
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`/pr-review failed: ${message}`, "error");
}

/** Default selection: everything except outdated inline comments, diff off. */
function defaultSelection(feedback: PullFeedback): SelectionEntry[] {
  return feedback.items
    .filter((item) => !(item.kind === "inline" && item.outdated))
    .map((item) => ({ item, includeDiff: false }));
}

function sendPrompt(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  feedback: PullFeedback,
  selection: SelectionEntry[],
): void {
  const prompt = buildPrompt(feedback.pr, selection);
  if (ctx.isIdle()) {
    pi.sendUserMessage(prompt);
    return;
  }
  pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  ctx.ui.notify("Queued the PR review as a follow-up", "info");
}

/** Fetch feedback behind a cancellable loader in TUI mode. */
async function loadFeedback(
  ctx: ExtensionCommandContext,
  exec: GhExecutor,
  prNumber: number | undefined,
): Promise<PullFeedback | null> {
  if (ctx.mode !== "tui") {
    try {
      return await fetchPullFeedback(exec, ctx.cwd, prNumber, ctx.signal);
    } catch (error) {
      notifyError(ctx, error);
      return null;
    }
  }

  let aborted = false;
  let fetchError: unknown;
  let settled = false;

  const feedback = await ctx.ui.custom<PullFeedback | null>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, "Fetching PR feedback…");
    loader.onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      aborted = true;
      done(null);
    };
    fetchPullFeedback(exec, ctx.cwd, prNumber, loader.signal)
      .then((result) => {
        if (settled) {
          return;
        }
        settled = true;
        done(result);
      })
      .catch((error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        fetchError = error;
        done(null);
      });
    return loader;
  });

  if (!feedback) {
    if (fetchError && !aborted) {
      notifyError(ctx, fetchError);
    }
    return null;
  }
  return feedback;
}

/** Show the triage window; returns null when the user cancels. */
function showTriage(
  ctx: ExtensionCommandContext,
  feedback: PullFeedback,
): Promise<SelectionEntry[] | null> {
  const entries: TriageEntry[] = feedback.items.map((item) => ({
    item,
    selected: !(item.kind === "inline" && item.outdated),
    includeDiff: false,
  }));

  return ctx.ui.custom<SelectionEntry[] | null>((tui, theme, _keybindings, done) => {
    const rows = tui.terminal.rows;
    const maxListRows = Math.max(3, Math.min(entries.length, 10, Math.floor(rows * 0.35)));
    const maxPreviewLines = Math.max(3, Math.min(12, rows - maxListRows - 8));

    return new ReviewTriageComponent({
      title: `${feedback.pr.owner}/${feedback.pr.repo}#${feedback.pr.number} "${feedback.pr.title}"`,
      entries,
      currentUser: feedback.currentUser,
      theme,
      maxListRows,
      maxPreviewLines,
      requestRender: () => tui.requestRender(),
      onDone: done,
    });
  });
}

export default function pgpExtension(pi: ExtensionAPI): void {
  pi.registerCommand("pr-review", {
    description: "Fetch GitHub PR review feedback (read-only) and address it",
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (raw && !/^\d+$/.test(raw)) {
        ctx.ui.notify("Usage: /pr-review [PR number]", "warning");
        return;
      }
      const prNumber = raw ? Number.parseInt(raw, 10) : undefined;
      const exec: GhExecutor = (command, cmdArgs, options) => pi.exec(command, cmdArgs, options);

      const feedback = await loadFeedback(ctx, exec, prNumber);
      if (!feedback) {
        return;
      }
      if (feedback.items.length === 0) {
        ctx.ui.notify(
          `No review feedback found for ${feedback.pr.owner}/${feedback.pr.repo}#${feedback.pr.number}`,
          "info",
        );
        return;
      }

      // Non-TUI modes (print/json/rpc) skip the window and use the defaults.
      if (ctx.mode !== "tui") {
        sendPrompt(pi, ctx, feedback, defaultSelection(feedback));
        return;
      }

      const selection = await showTriage(ctx, feedback);
      if (!selection) {
        ctx.ui.notify("PR review cancelled", "info");
        return;
      }
      sendPrompt(pi, ctx, feedback, selection);
    },
  });
}
