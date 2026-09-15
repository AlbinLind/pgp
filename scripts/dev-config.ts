/**
 * Dev-only unit test for config parsing and precedence.
 *
 *   node scripts/dev-config.ts
 */

import {
  DEFAULT_CONFIG,
  clampDiffContext,
  globalConfigPath,
  loadConfig,
  parseConfig,
  projectConfigPath,
} from "../src/config.ts";

let failures = 0;
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ""}`);
  }
}

// --- parsing -----------------------------------------------------------------
check("parse: valid", parseConfig({ diffContext: 5 }).diffContext === 5);
check("parse: clamps high", parseConfig({ diffContext: 999 }).diffContext === 20);
check("parse: clamps low", parseConfig({ diffContext: 0 }).diffContext === 1);
check("parse: truncates", parseConfig({ diffContext: 2.9 }).diffContext === 2);
check("parse: ignores non-number", parseConfig({ diffContext: "5" }).diffContext === undefined);
check("parse: ignores null", parseConfig(null).diffContext === undefined);
check("parse: ignores array", parseConfig([1]).diffContext === undefined);
check("clamp: NaN falls back", clampDiffContext(Number.NaN) === DEFAULT_CONFIG.diffContext);

// --- precedence --------------------------------------------------------------
const agentDir = "/tmp/pgp-test-agent";
const cwd = "/tmp/pgp-test-project";
const globalPath = globalConfigPath(agentDir);
const projectPath = projectConfigPath(cwd);

function loadWith(files: Record<string, string>, trusted: boolean): ReturnType<typeof loadConfig> {
  const read = (path: string): string | undefined => files[path];
  return loadConfig({ cwd, isProjectTrusted: () => trusted }, read, agentDir);
}

{
  const result = loadWith({}, true);
  check("defaults when no files", result.config.diffContext === 3 && result.warnings.length === 0);
}

{
  const result = loadWith({ [globalPath]: JSON.stringify({ diffContext: 7 }) }, true);
  check("global overrides default", result.config.diffContext === 7);
}

{
  const result = loadWith(
    {
      [globalPath]: JSON.stringify({ diffContext: 7 }),
      [projectPath]: JSON.stringify({ diffContext: 12 }),
    },
    true,
  );
  check("trusted project overrides global", result.config.diffContext === 12);
}

{
  const result = loadWith(
    {
      [globalPath]: JSON.stringify({ diffContext: 7 }),
      [projectPath]: JSON.stringify({ diffContext: 12 }),
    },
    false,
  );
  check("untrusted project is ignored", result.config.diffContext === 7);
}

{
  const result = loadWith({ [globalPath]: "{ not json" }, true);
  check("malformed file warns and falls back", result.config.diffContext === 3);
  check("malformed file produces a warning", result.warnings.some((w) => w.includes("malformed")));
}

console.log(failures === 0 ? "\nAll config checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
