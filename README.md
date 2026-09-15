# PGP — Pi GitHub PRs

A [pi](https://pi.dev) extension that pulls the review feedback from a GitHub
pull request into your session, lets you triage it, and then has the agent
**fix or explain** each item.

It is **read-only against GitHub**: it fetches comments, it never posts,
replies, resolves, or otherwise changes the PR.

![PGP quick demo](https://raw.githubusercontent.com/AlbinLind/pgp/main/media/quick-demo.gif)

## Why

`gh pr view` shows the conversation and the review summaries, but not the
inline diff comments. This extension fetches all three feedback sources:

| Source | GitHub endpoint |
|--------|-----------------|
| Inline diff review comments (threaded) | `GET /repos/{owner}/{repo}/pulls/{n}/comments` |
| Review summaries (review bodies) | `GET /repos/{owner}/{repo}/pulls/{n}/reviews` |
| General PR comments | `GET /repos/{owner}/{repo}/issues/{n}/comments` |
| Full file patches (hunk context) | `GET /repos/{owner}/{repo}/pulls/{n}/files` |

Empty review bodies (GitHub creates one per inline comment) are filtered out.
Replies are grouped into threads, and outdated comments are marked.

GitHub truncates each comment's `diff_hunk` to end at the commented line, so it
never contains code *after* the comment. PGP fetches the PR's file patches and
resolves the full hunk from there, so the diff context shown to you and the
agent has both sides.

## Requirements

- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
  (`gh auth login`).
- Run pi from inside the git repository whose PR you want to review.

## Install

```bash
# published package
pi install npm:@albinn/pgp

# or straight from git, pinned to a release tag
pi install git:github.com/AlbinLind/pgp@v0.1.0

# local development checkout
pi -e ./src/index.ts
```

The extension ships a `pi` manifest in `package.json`
(`"extensions": ["./src/index.ts"]`), so a directory install picks it up
automatically.

## Usage

```
/pr-review [PR number]
```

- `/pr-review` — uses the PR for the current branch.
- `/pr-review 123` — uses PR #123.

The command:

1. Resolves the PR (owner/repo/number).
2. Fetches all three feedback sources (cancellable with `Esc`).
3. Opens the **triage window**.
4. Sends the selected items to the agent with instructions to fix or explain
   each one.

## The triage window

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ AlbinLind/pgp#1 "add readme" — 4 item(s) · 3 selected · @AlbinLind           │
│   ↑↓ move · space toggle · a all · u/U mine · r/R review · c/C comment · d … │
├──────────────────────────────────────────────────────────────────────────────┤
│ ❯ [x] [inline] README.md:3        @AlbinLind  Test comment                  │
│   [ ] [inline] README.md:5        @AlbinLind  (outdated) Comment on some…   │
│   [x] [review] COMMENTED          @AlbinLind  Summary of review             │
│   [x] [issue]  PR comment         @AlbinLind  A normal comment              │
├──────────────────────────────────────────────────────────────────────────────┤
│ [inline] README.md:3 · @AlbinLind · 2026-09-14                              │
│   Test comment                                                              │
│   ↳ @reviewer: A reply                                                      │
│   diff: off (±3 lines) · d toggle · [ fewer · ] more                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

The preview pane shows the full body, thread replies, and — when enabled with
`d` — the diff hunk.

When the diff is shown it is **sliced to the lines around the comment** rather
than dumping the whole hunk: `[` shows fewer context lines and `]` shows more
(default 3, clamped to 1–20).

### Keys

| Key | Action |
|-----|--------|
| `↑` / `↓` (or `k` / `j`) | Move cursor |
| `pgup` / `pgdn` | Move by page |
| `space` | Toggle highlighted item |
| `a` | Toggle select-all / deselect-all |
| `u` | Select all **mine**, keeping the current selection |
| `U` | Select **only** mine |
| `r` | Select all **review** items (inline + summaries), keeping the selection |
| `R` | Select **only** review items |
| `c` | Select all **general comments**, keeping the selection |
| `C` | Select **only** general comments |
| `d` | Toggle diff-hunk inclusion for the highlighted inline thread |
| `[` / `]` | Fewer / more context lines around the commented line (turns the diff on) |
| `enter` | Confirm selection |
| `esc` | Cancel |

Lowercase bulk keys only **add** to the selection; uppercase keys **replace**
it. Bulk selection preserves per-item diff toggles.

### Defaults

- Everything is selected **except outdated inline comments** (still shown so
  you can opt in).
- Diff hunks are **off** by default and included only for items where you
  pressed `d`. When on, only the slice around the commented line(s) is shown;
  the size of that slice comes from config (default 3).
- "mine" means the authenticated `gh` user.

## Configuration

PGP reads its own JSON config (pi has no per-extension settings namespace):

| Location | Scope |
|----------|-------|
| `~/.pi/agent/pgp.json` | Global |
| `.pi/pgp.json` | Project (only when the project is trusted) |

```json
{
  "diffContext": 3
}
```

`diffContext` is the number of context lines shown on each side of the
commented line when a diff is included. It is clamped to `1..20`; project values
override global values, and malformed files are ignored with a warning. The
value only sets the slice size — diffs still start out off until you press `d`
(or `[` / `]`).

## What the agent sees

The selected items are sent as a `pgp-review` message. The agent is told to
either:

- **Fix it** — make the code change and say what changed and why, or
- **Explain it** — justify why no change is warranted, referencing the code.

It is explicitly instructed not to post, reply, resolve, or modify anything on
GitHub, and to re-check stale/outdated line numbers against the working tree
before editing. The message renders in the transcript as a compact card and
shows the full prompt when expanded.

## Non-interactive modes

In print / JSON / RPC modes there is no triage window. The command fetches all
feedback and sends the prompt using the defaults above, so `/pr-review` works
in scripts and headless runs.

## Development

```bash
npm install
npm run check        # strict TypeScript
npm run dev:fetch 1  # fetch + normalize + print prompt (no pi)
npm run dev:triage   # headless tests for the triage component
npm run dev:command 1 # integration test for the non-TUI command path
npm run dev:tui 1    # integration test for the TUI path (loader + window)
```

To try it interactively against this repository's PR #1:

```bash
pi -e ./src/index.ts
/pr-review 1
```

## Roadmap

- Reply to comments on GitHub (first write path; needs an explicit confirmation
  gate).
- Hide already-resolved threads (GraphQL `reviewThreads.isResolved`).
- Filters for "unresolved only" / "not authored by me".
- Expose a `github_pr_feedback` tool so the agent can re-fetch/filter itself.
