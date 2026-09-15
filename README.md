# PGP — Pi GitHub PRs

A [pi](https://pi.dev) extension that pulls the review feedback from a GitHub
pull request into your session, lets you triage it, and then has the agent
**fix or explain** each item.

It is **read-only against GitHub**: it fetches comments, it never posts,
replies, resolves, or otherwise changes the PR.

## Why

`gh pr view` shows the conversation and the review summaries, but not the
inline diff comments. This extension fetches all three feedback sources:

| Source | GitHub endpoint |
|--------|-----------------|
| Inline diff review comments (threaded) | `GET /repos/{owner}/{repo}/pulls/{n}/comments` |
| Review summaries (review bodies) | `GET /repos/{owner}/{repo}/pulls/{n}/reviews` |
| General PR comments | `GET /repos/{owner}/{repo}/issues/{n}/comments` |

Empty review bodies (GitHub creates one per inline comment) are filtered out.
Replies are grouped into threads, and outdated comments are marked.

## Requirements

- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
  (`gh auth login`).
- Run pi from inside the git repository whose PR you want to review.

## Install

```bash
# once the repo is published
pi install git:github.com/AlbinLind/pgp

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
│   diff: off (press d to toggle)                                             │
└──────────────────────────────────────────────────────────────────────────────┘
```

The preview pane shows the full body, thread replies, and — when enabled with
`d` — the diff hunk.

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
| `enter` | Confirm selection |
| `esc` | Cancel |

Lowercase bulk keys only **add** to the selection; uppercase keys **replace**
it. Bulk selection preserves per-item diff toggles.

### Defaults

- Everything is selected **except outdated inline comments** (still shown so
  you can opt in).
- Diff hunks are **off** by default and included only for items where you
  pressed `d`.
- "mine" means the authenticated `gh` user.

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
