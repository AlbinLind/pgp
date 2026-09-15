/**
 * Dev-only integration test for the `/pr-review` TUI path: loader fetch plus
 * the triage window. Fakes ctx.ui.custom() with a scripted component driver.
 *
 *   node scripts/dev-tui-command.ts [PR number]
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import pgpExtension from "../src/index.ts";
import { ReviewTriageComponent } from "../src/ui/triage.ts";

try {
  initTheme("dark", false);
} catch {
  // Global theme is only needed for key-hint formatting inside BorderedLoader.
}

const identity = (text: string): string => text;
const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: identity,
  italic: identity,
  underline: identity,
  inverse: identity,
  strikethrough: identity,
} as unknown as Theme;

const fakeTui = {
  terminal: { rows: 40 },
  requestRender: () => {},
  setFocus: () => {},
};

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
let sent: Array<{ content: unknown; options: unknown }> = [];
const pi = {
  exec,
  sendUserMessage: (content: unknown, options?: unknown) => {
    sent.push({ content, options });
  },
  registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
    if (name === "pr-review") {
      handler = options.handler;
    }
  },
} as unknown as ExtensionAPI;

pgpExtension(pi);
if (!handler) {
  throw new Error("pr-review command was not registered");
}

const notices: string[] = [];

function makeTuiCtx(driveComponent: (component: ReviewTriageComponent) => void) {
  let customCall = 0;
  return {
    mode: "tui",
    cwd: process.cwd(),
    signal: undefined,
    isIdle: () => true,
    ui: {
      notify: (message: string, level: string) => {
        notices.push(`[${level}] ${message}`);
        console.log(`notify ${level}: ${message}`);
      },
      setStatus: () => {},
      custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => unknown) =>
        new Promise((resolve) => {
          customCall++;
          let component: { dispose?: () => void } | undefined;
          const done = (value: unknown) => {
            if (typeof component?.dispose === "function") {
              component.dispose();
            }
            resolve(value);
          };
          component = factory(fakeTui, fakeTheme, {}, done) as { dispose?: () => void };
          if (component instanceof ReviewTriageComponent) {
            driveComponent(component);
          }
        }),
    },
  };
}

const prArg = process.argv[2] ?? "1";

// --- confirm path -----------------------------------------------------------
console.log(`--- /pr-review ${prArg} (TUI path, confirm) ---`);
notices.length = 0;
sent = [];
await handler(prArg, makeTuiCtx((component) => {
  component.handleInput("d"); // include diff for the first inline item
  component.handleInput("\r");
}));

if (sent.length !== 1) {
  console.error(`FAIL: expected 1 sendUserMessage call, got ${sent.length}`);
  process.exit(1);
}
const content = String(sent[0].content);
for (const snippet of ["README.md:3", "Summary of review", "A normal comment", "```diff"]) {
  if (!content.includes(snippet)) {
    console.error(`FAIL: prompt missing ${snippet}`);
    process.exit(1);
  }
}
if (content.includes("Comment on something that will be gone")) {
  console.error("FAIL: outdated comment should be excluded by default");
  process.exit(1);
}
console.log("ok: TUI path sent the expected prompt with per-item diff");

// --- cancel path ------------------------------------------------------------
console.log(`--- /pr-review ${prArg} (TUI path, cancel) ---`);
notices.length = 0;
sent = [];
await handler(prArg, makeTuiCtx((component) => {
  component.handleInput("\x1b");
}));
if (sent.length !== 0 || !notices.some((notice) => notice.includes("cancelled"))) {
  console.error(`FAIL: cancel did not abort cleanly (sent: ${sent.length}, notices: ${notices.join(" | ")})`);
  process.exit(1);
}
console.log("ok: cancelling the triage window sends nothing");

console.log("\nAll TUI command checks passed.");
process.exit(0);
