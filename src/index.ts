/**
 * PGP — Pi GitHub PRs
 *
 * Phase 1: a read-only `/pr-review` command that resolves a PR, fetches all
 * feedback (inline review comments, review summaries, and general comments),
 * and renders a summary entry so the data can be validated before the triage
 * window (Phase 2) exists.
 *
 * The extension only reads from GitHub. It never posts, replies, resolves, or
 * otherwise mutates the PR.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
  buildPrompt,
  feedbackAuthors,
  feedbackLocation,
  feedbackPreview,
} from "./format.ts";
import { type GhExecutor, GitHubError, fetchPullFeedback } from "./github.ts";
import type { Feedback, SelectionResult } from "./types.ts";

const SUMMARY_ENTRY = "pgp-review-summary";

interface SummaryItem {
  index: number;
  kind: Feedback["kind"];
  location: string;
  authors: string[];
  preview: string;
  outdated: boolean;
}

interface SummaryData {
  header: string;
  url: string;
  currentUser?: string;
  items: SummaryItem[];
  prompt: string;
}

export default function pgpExtension(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<SummaryData>(SUMMARY_ENTRY, (entry, { expanded }, theme) => {
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const data = entry.data;
    if (!data) {
      box.addChild(new Text(theme.fg("error", "[pgp] no feedback data"), 0, 0));
      return box;
    }

    box.addChild(new Text(theme.fg("accent", theme.bold(`[pgp] ${data.header}`)), 0, 0));
    box.addChild(new Text(theme.fg("dim", data.url), 0, 0));

    for (const item of data.items) {
      const authors = item.authors.map((author) => `@${author}`).join(", ");
      const outdated = item.outdated ? theme.fg("warning", " (outdated)") : "";
      const label = theme.fg("muted", `[${item.kind}] ${item.location}`);
      box.addChild(
        new Text(
          `${theme.fg("dim", String(item.index).padStart(2, " "))}. ${label} ${authors}${outdated} — ${item.preview}`,
          0,
          0,
        ),
      );
    }

    if (data.currentUser) {
      box.addChild(new Text(theme.fg("dim", `authenticated as @${data.currentUser}`), 0, 0));
    }

    if (expanded) {
      box.addChild(new Text(theme.fg("dim", data.prompt), 0, 0));
    }

    return box;
  });

  pi.registerCommand("pr-review", {
    description: "Fetch GitHub PR review feedback (read-only) and prepare it for the agent",
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (raw && !/^\d+$/.test(raw)) {
        ctx.ui.notify("Usage: /pr-review [PR number]", "warning");
        return;
      }
      const prNumber = raw ? Number.parseInt(raw, 10) : undefined;
      const exec: GhExecutor = (command, cmdArgs, options) => pi.exec(command, cmdArgs, options);

      ctx.ui.setStatus("pgp-review", "Fetching PR feedback…");
      try {
        const { pr, items, currentUser } = await fetchPullFeedback(
          exec,
          ctx.cwd,
          prNumber,
          ctx.signal,
        );

        if (items.length === 0) {
          ctx.ui.notify(
            `No review feedback found for ${pr.owner}/${pr.repo}#${pr.number}`,
            "info",
          );
          return;
        }

        // Phase 1 defaults: every non-outdated item selected, diff hunk off.
        const defaultSelection: SelectionResult = items
          .filter((item) => !(item.kind === "inline" && item.outdated))
          .map((item) => ({ item, includeDiff: false }));

        const summary: SummaryData = {
          header: `${pr.owner}/${pr.repo}#${pr.number} "${pr.title}"`,
          url: pr.url,
          currentUser,
          items: items.map((item, index) => ({
            index: index + 1,
            kind: item.kind,
            location: feedbackLocation(item),
            authors: feedbackAuthors(item),
            preview: feedbackPreview(item),
            outdated: item.kind === "inline" && item.outdated,
          })),
          prompt: buildPrompt(pr, defaultSelection),
        };

        pi.appendEntry(SUMMARY_ENTRY, summary);
        ctx.ui.notify(
          `Fetched ${items.length} feedback item(s) for ${pr.owner}/${pr.repo}#${pr.number}`,
          "info",
        );
      } catch (error) {
        if (error instanceof GitHubError) {
          ctx.ui.notify(
            `${error.message}${error.detail ? `: ${error.detail}` : ""}`,
            "error",
          );
        } else {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`/pr-review failed: ${message}`, "error");
        }
      } finally {
        ctx.ui.setStatus("pgp-review", undefined);
      }
    },
  });
}
