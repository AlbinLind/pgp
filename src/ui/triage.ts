/**
 * Interactive review triage window.
 *
 * A multi-select list of normalized PR feedback with a context preview pane.
 * It is rendered via `ctx.ui.custom()` and returns the selected items (plus
 * their per-item diff toggle), or null when cancelled.
 *
 * Keys:
 *   ↑/↓ or k/j    move
 *   space         toggle highlighted item
 *   a             toggle select-all / deselect-all
 *   u / U         select all mine (add) / only mine (replace)
 *   r / R         select all review items (add) / only review (replace)
 *   c / C         select all general comments (add) / only comments (replace)
 *   d             toggle diff-hunk inclusion for the highlighted inline thread
 *   enter         confirm
 *   esc           cancel
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Key,
  decodeKittyPrintable,
  matchesKey,
  parseKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  feedbackAuthors,
  feedbackCategory,
  feedbackLocation,
  feedbackPreview,
} from "../format.ts";
import type { Feedback, FeedbackCategory, SelectionEntry } from "../types.ts";

export interface TriageEntry {
  item: Feedback;
  selected: boolean;
  includeDiff: boolean;
}

export type TriageResult = SelectionEntry[] | null;

export interface TriageOptions {
  title: string;
  entries: TriageEntry[];
  currentUser?: string;
  theme: Theme;
  maxListRows: number;
  maxPreviewLines: number;
  requestRender: () => void;
  onDone: (result: TriageResult) => void;
}

type LetterMatch = "lower" | "upper" | undefined;

/**
 * Case-sensitive letter matching that works with legacy input (`u`/`U`) and
 * Kitty keyboard protocol sequences (`shift+u`, shifted keycodes).
 */
function matchLetter(data: string, letter: string): LetterMatch {
  const upper = letter.toUpperCase();
  const parsed = parseKey(data);
  if (parsed === letter) {
    return "lower";
  }
  if (parsed === upper || parsed === `shift+${letter}`) {
    return "upper";
  }
  const printable = decodeKittyPrintable(data);
  if (printable === letter) {
    return "lower";
  }
  if (printable === upper) {
    return "upper";
  }
  return undefined;
}

function padVisual(text: string, width: number): string {
  const current = visibleWidth(text);
  if (current >= width) {
    return truncateToWidth(text, width, "");
  }
  return text + " ".repeat(width - current);
}

function wrapWithPrefix(
  text: string,
  width: number,
  firstPrefix: string,
  restPrefix: string,
): string[] {
  if (!text.trim()) {
    return [];
  }
  const prefixWidth = Math.max(visibleWidth(firstPrefix), visibleWidth(restPrefix));
  const available = Math.max(1, width - prefixWidth);
  return wrapTextWithAnsi(text, available).map((line, index) =>
    index === 0 ? firstPrefix + line : restPrefix + line,
  );
}

function clampPreview(lines: string[], maxLines: number, theme: Theme): string[] {
  if (lines.length <= maxLines) {
    return lines;
  }
  const kept = lines.slice(0, Math.max(1, maxLines - 1));
  kept.push(theme.fg("dim", `… ${lines.length - kept.length} more line(s)`));
  return kept;
}

function formatDate(iso: string): string {
  return iso ? iso.slice(0, 10) : "";
}

function diffColor(line: string): ThemeColor {
  if (line.startsWith("+")) {
    return "toolDiffAdded";
  }
  if (line.startsWith("-")) {
    return "toolDiffRemoved";
  }
  return "toolDiffContext";
}

function kindColor(kind: Feedback["kind"]): ThemeColor {
  switch (kind) {
    case "inline":
      return "accent";
    case "review":
      return "warning";
    case "issue":
      return "muted";
  }
}

export class ReviewTriageComponent implements Component {
  private readonly title: string;
  private readonly entries: TriageEntry[];
  private readonly currentUser?: string;
  private readonly theme: Theme;
  private readonly maxListRows: number;
  private readonly maxPreviewLines: number;
  private readonly requestRender: () => void;
  private readonly onDone: (result: TriageResult) => void;

  private cursor = 0;
  private scrollOffset = 0;
  private notice?: string;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(options: TriageOptions) {
    this.title = options.title;
    this.entries = options.entries;
    this.currentUser = options.currentUser;
    this.theme = options.theme;
    this.maxListRows = Math.max(1, options.maxListRows);
    this.maxPreviewLines = Math.max(1, options.maxPreviewLines);
    this.requestRender = options.requestRender;
    this.onDone = options.onDone;
  }

  handleInput(data: string): void {
    this.notice = undefined;

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onDone(null);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.confirm();
      return;
    }
    if (matchesKey(data, Key.up) || matchLetter(data, "k")) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, Key.down) || matchLetter(data, "j")) {
      this.move(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.move(-this.visibleListRows());
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.move(this.visibleListRows());
      return;
    }
    if (matchesKey(data, Key.space)) {
      this.toggleCursor();
      return;
    }

    if (matchLetter(data, "a")) {
      this.bulkToggleAll();
      return;
    }
    const u = matchLetter(data, "u");
    if (u) {
      this.bulkMine(u === "upper");
      return;
    }
    const r = matchLetter(data, "r");
    if (r) {
      this.bulkCategory("review", r === "upper");
      return;
    }
    const c = matchLetter(data, "c");
    if (c) {
      this.bulkCategory("comment", c === "upper");
      return;
    }
    if (matchLetter(data, "d")) {
      this.toggleDiff();
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    const lines = this.buildLines(width).map((line) => truncateToWidth(line, width, ""));
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private finish(result: TriageResult): void {
    this.onDone(result);
  }

  private refresh(): void {
    this.invalidate();
    this.requestRender();
  }

  private visibleListRows(): number {
    return Math.max(1, Math.min(this.maxListRows, this.entries.length));
  }

  private move(delta: number): void {
    if (this.entries.length === 0) {
      return;
    }
    const next = Math.max(0, Math.min(this.entries.length - 1, this.cursor + delta));
    if (next === this.cursor) {
      return;
    }
    this.cursor = next;
    this.ensureCursorVisible();
    this.refresh();
  }

  private ensureCursorVisible(): void {
    const rows = this.visibleListRows();
    if (this.cursor < this.scrollOffset) {
      this.scrollOffset = this.cursor;
    } else if (this.cursor >= this.scrollOffset + rows) {
      this.scrollOffset = this.cursor - rows + 1;
    }
    const maxOffset = Math.max(0, this.entries.length - rows);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
  }

  private toggleCursor(): void {
    const entry = this.entries[this.cursor];
    if (!entry) {
      return;
    }
    entry.selected = !entry.selected;
    this.refresh();
  }

  private bulkToggleAll(): void {
    const allSelected = this.entries.every((entry) => entry.selected);
    for (const entry of this.entries) {
      entry.selected = !allSelected;
    }
    this.refresh();
  }

  /** Lowercase keys add to the selection; uppercase keys replace it. */
  private bulkMine(only: boolean): void {
    if (!this.currentUser) {
      this.notice = "Authenticated gh user unknown — cannot filter by author";
      this.refresh();
      return;
    }
    for (const entry of this.entries) {
      const mine = feedbackAuthors(entry.item).includes(this.currentUser);
      if (mine) {
        entry.selected = true;
      } else if (only) {
        entry.selected = false;
      }
    }
    this.refresh();
  }

  private bulkCategory(category: FeedbackCategory, only: boolean): void {
    for (const entry of this.entries) {
      const matches = feedbackCategory(entry.item) === category;
      if (matches) {
        entry.selected = true;
      } else if (only) {
        entry.selected = false;
      }
    }
    this.refresh();
  }

  private toggleDiff(): void {
    const entry = this.entries[this.cursor];
    if (!entry) {
      return;
    }
    if (entry.item.kind !== "inline") {
      this.notice = "Diff hunks only apply to inline review comments";
      this.refresh();
      return;
    }
    entry.includeDiff = !entry.includeDiff;
    this.refresh();
  }

  private confirm(): void {
    const selected = this.entries
      .filter((entry) => entry.selected)
      .map((entry) => ({ item: entry.item, includeDiff: entry.includeDiff }));
    if (selected.length === 0) {
      this.notice = "Select at least one item, or press esc to cancel";
      this.refresh();
      return;
    }
    this.finish(selected);
  }

  private border(width: number, color: ThemeColor): string {
    return this.theme.fg(color, "─".repeat(Math.max(0, width)));
  }

  private buildLines(width: number): string[] {
    const lines: string[] = [];

    lines.push(this.border(width, "border"));
    lines.push(this.headerLine(width));
    lines.push(truncateToWidth(this.helpLine(), width, "…"));
    if (this.notice) {
      lines.push(truncateToWidth(this.theme.fg("warning", `! ${this.notice}`), width, "…"));
    }
    lines.push(this.border(width, "borderMuted"));

    const rows = this.visibleListRows();
    const start = this.scrollOffset;
    const end = Math.min(this.entries.length, start + rows);
    for (let index = start; index < end; index++) {
      lines.push(this.renderRow(index, width));
    }
    if (this.entries.length > rows) {
      lines.push(
        truncateToWidth(
          this.theme.fg("dim", `  (${this.cursor + 1}/${this.entries.length})`),
          width,
          "…",
        ),
      );
    }

    lines.push(this.border(width, "borderMuted"));
    for (const line of this.renderPreview(width)) {
      lines.push(line);
    }
    lines.push(this.border(width, "border"));

    return lines;
  }

  private headerLine(width: number): string {
    const selectedCount = this.entries.filter((entry) => entry.selected).length;
    const counts = `${this.entries.length} item(s) · ${selectedCount} selected`;
    const heading = this.theme.fg("accent", this.theme.bold(this.title));
    const user = this.currentUser ? this.theme.fg("dim", ` · @${this.currentUser}`) : "";
    return truncateToWidth(`${heading} ${this.theme.fg("dim", `— ${counts}`)}${user}`, width, "…");
  }

  private helpLine(): string {
    const parts = [
      "↑↓ move",
      "space toggle",
      "a all",
      "u/U mine",
      "r/R review",
      "c/C comment",
      "d diff",
      "enter review",
      "esc cancel",
    ];
    return this.theme.fg("dim", `  ${parts.join(" · ")}`);
  }

  private renderRow(index: number, width: number): string {
    const entry = this.entries[index];
    const isCursor = index === this.cursor;

    const cursor = isCursor ? `${this.theme.fg("accent", "❯")} ` : "  ";
    const check = entry.selected ? this.theme.fg("success", "[x]") : this.theme.fg("dim", "[ ]");
    const kind = this.theme.fg(kindColor(entry.item.kind), `[${entry.item.kind}]`);

    const locationWidth = width >= 84 ? 26 : width >= 64 ? 18 : 0;
    const authorWidth = width >= 100 ? 16 : 0;

    let row = `${cursor}${padVisual(check, 4)}${padVisual(kind, 9)}`;
    if (locationWidth > 0) {
      const location = truncateToWidth(feedbackLocation(entry.item), locationWidth, "…");
      row += padVisual(location, locationWidth + 1);
    }
    if (authorWidth > 0) {
      const authors = feedbackAuthors(entry.item)
        .map((author) => `@${author}`)
        .join(", ");
      row += padVisual(truncateToWidth(authors, authorWidth, "…"), authorWidth + 1);
    }

    const outdated =
      entry.item.kind === "inline" && entry.item.outdated
        ? this.theme.fg("warning", " (outdated)")
        : "";
    const diffMark =
      entry.item.kind === "inline"
        ? this.theme.fg(entry.includeDiff ? "success" : "dim", entry.includeDiff ? " ±" : " ·")
        : "";

    const used = visibleWidth(row) + visibleWidth(outdated) + visibleWidth(diffMark) + 1;
    const previewWidth = Math.max(0, width - used);
    const preview =
      previewWidth > 0
        ? truncateToWidth(feedbackPreview(entry.item, 200), previewWidth, "…")
        : "";

    row += outdated + preview + diffMark;

    if (entry.selected || isCursor) {
      return this.theme.bg("selectedBg", padVisual(row, width));
    }
    return row;
  }

  private renderPreview(width: number): string[] {
    const entry = this.entries[this.cursor];
    if (!entry) {
      return [this.theme.fg("dim", "  No feedback items")];
    }

    const item = entry.item;
    const authors = feedbackAuthors(item)
      .map((author) => `@${author}`)
      .join(", ");
    const outdated = item.kind === "inline" && item.outdated ? " · outdated" : "";
    const date =
      item.kind === "inline"
        ? item.comments[0]?.createdAt
        : item.kind === "review"
          ? item.submittedAt
          : item.createdAt;
    const meta = `[${item.kind}] ${feedbackLocation(item)} · ${authors}${outdated}${date ? ` · ${formatDate(date)}` : ""}`;
    const out: string[] = [truncateToWidth(this.theme.fg("muted", meta), width, "…")];

    if (item.kind === "inline") {
      const root = item.comments[0];
      if (root) {
        out.push(...wrapWithPrefix(this.theme.fg("text", root.body), width, "  ", "  "));
      }
      for (const reply of item.comments.slice(1)) {
        const author = `@${reply.author}`;
        const firstPrefix = `${this.theme.fg("dim", "  ↳ ")}${this.theme.fg("accent", author)}${this.theme.fg("dim", ": ")}`;
        const restPrefix = " ".repeat(4 + visibleWidth(author) + 2);
        out.push(...wrapWithPrefix(this.theme.fg("text", reply.body), width, firstPrefix, restPrefix));
      }

      const diffState = entry.includeDiff
        ? this.theme.fg("success", "on")
        : this.theme.fg("dim", "off");
      out.push(
        `${this.theme.fg("muted", `  diff: ${diffState}`)}${this.theme.fg("dim", " (press d to toggle)")}`,
      );
      if (entry.includeDiff && item.diffHunk.trim()) {
        for (const hunkLine of item.diffHunk.split("\n")) {
          out.push(this.theme.fg(diffColor(hunkLine), `  ${hunkLine}`));
        }
      }
    } else {
      out.push(...wrapWithPrefix(this.theme.fg("text", item.body), width, "  ", "  "));
    }

    return clampPreview(out, this.maxPreviewLines, this.theme);
  }
}
