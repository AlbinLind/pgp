/**
 * Dev-only integration test for the `/pr-review` command handler's non-TUI
 * path (print/json/rpc). Uses a fake pi/ctx and the real `gh` CLI.
 *
 *   node scripts/dev-command.ts [PR number]
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pgpExtension from "../src/index.ts";

const execFileAsync = promisify(execFile);

const exec = async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
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

let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
const sent: Array<{ content: unknown; options: unknown }> = [];

const pi = {
  exec,
  sendMessage: (message: { content?: unknown }, options?: unknown) => {
    sent.push({ content: message.content, options });
  },
  sendUserMessage: (content: unknown, options?: unknown) => {
    sent.push({ content, options });
  },
  registerMessageRenderer: () => {},
  registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
    if (name === "pr-review") {
      handler = options.handler;
    }
  },
} as unknown as ExtensionAPI;

const notices: string[] = [];
function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    mode: "json",
    cwd: process.cwd(),
    signal: undefined,
    isIdle: () => true,
    ui: {
      notify: (message: string, level: string) => {
        notices.push(`[${level}] ${message}`);
        console.log(`notify ${level}: ${message}`);
      },
      setStatus: () => {},
      custom: () => {
        throw new Error("custom() should not be called in non-TUI mode");
      },
    },
    ...overrides,
  };
}

pgpExtension(pi);
if (!handler) {
  throw new Error("pr-review command was not registered");
}

const prArg = process.argv[2] ?? "1";
console.log(`--- running /pr-review ${prArg} (non-TUI path) ---`);
await handler(prArg, makeCtx());

if (sent.length !== 1) {
  console.error(`FAIL: expected 1 sendUserMessage call, got ${sent.length}`);
  process.exit(1);
}
const content = String(sent[0].content);
const required = [
  "# Address GitHub review feedback",
  "Do NOT post, reply to, resolve, or modify anything on GitHub",
  "README.md:3",
  "Summary of review",
  "A normal comment",
];
const missing = required.filter((snippet) => !content.includes(snippet));
if (missing.length > 0) {
  console.error(`FAIL: prompt missing expected content: ${missing.join(", ")}`);
  process.exit(1);
}
if (content.includes("Comment on something that will be gone")) {
  console.error("FAIL: outdated inline comment should be excluded by default");
  process.exit(1);
}
if (content.includes("```diff")) {
  console.error("FAIL: diff hunks should be excluded by default");
  process.exit(1);
}
console.log("ok: non-TUI path fetched feedback and sent the expected prompt");

// Invalid argument should warn and not send.
notices.length = 0;
sent.length = 0;
await handler("abc", makeCtx());
if (sent.length !== 0 || !notices.some((n) => n.includes("Usage: /pr-review"))) {
  console.error("FAIL: invalid PR argument was not rejected");
  process.exit(1);
}
console.log("ok: invalid argument rejected");

// Unknown PR should surface a GitHub error, not send.
notices.length = 0;
sent.length = 0;
await handler("999999", makeCtx());
if (sent.length !== 0 || !notices.some((n) => n.includes("error"))) {
  console.error(`FAIL: unknown PR did not surface an error (notices: ${notices.join(" | ")})`);
  process.exit(1);
}
console.log("ok: unknown PR surfaces an error");

console.log("\nAll command checks passed.");
