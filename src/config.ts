/**
 * PGP configuration.
 *
 * pi has no per-extension settings namespace, so PGP reads its own JSON:
 *
 *   ~/.pi/agent/pgp.json        global
 *   <cwd>/.pi/pgp.json          project (only when the project is trusted)
 *
 * Project values override global values. Missing files are ignored; malformed
 * files are ignored with a warning the caller can surface.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { MAX_DIFF_CONTEXT, MIN_DIFF_CONTEXT } from "./diff.ts";

export interface PgpConfig {
  /** Lines of context shown on each side of the commented line. */
  diffContext: number;
}

export const DEFAULT_CONFIG: PgpConfig = { diffContext: 3 };

/** The subset of `ExtensionCommandContext` that config loading needs. */
export interface ConfigContext {
  cwd: string;
  isProjectTrusted?: () => boolean;
}

/** Reads a file as UTF-8, or returns `undefined` when it cannot be read. */
export type ConfigReader = (path: string) => string | undefined;

export interface LoadedConfig {
  config: PgpConfig;
  warnings: string[];
}

export function globalConfigPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "pgp.json");
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "pgp.json");
}

export function clampDiffContext(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CONFIG.diffContext;
  }
  return Math.max(MIN_DIFF_CONTEXT, Math.min(MAX_DIFF_CONTEXT, Math.trunc(value)));
}

export function parseConfig(value: unknown): Partial<PgpConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const raw = (value as Record<string, unknown>).diffContext;
  if (typeof raw !== "number") {
    return {};
  }
  return { diffContext: clampDiffContext(raw) };
}

function readConfigFile(
  path: string,
  read: ConfigReader,
  warnings: string[],
): Partial<PgpConfig> | undefined {
  const raw = read(path);
  if (raw === undefined) {
    return undefined;
  }
  try {
    return parseConfig(JSON.parse(raw));
  } catch {
    warnings.push(`Ignoring malformed config file: ${path}`);
    return undefined;
  }
}

const defaultReader: ConfigReader = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

export function loadConfig(
  ctx: ConfigContext,
  read: ConfigReader = defaultReader,
  agentDir: string = getAgentDir(),
): LoadedConfig {
  const warnings: string[] = [];
  const config: PgpConfig = { ...DEFAULT_CONFIG };

  const global = readConfigFile(globalConfigPath(agentDir), read, warnings);
  if (global?.diffContext !== undefined) {
    config.diffContext = global.diffContext;
  }

  const trusted = ctx.isProjectTrusted ? ctx.isProjectTrusted() : false;
  if (trusted) {
    const project = readConfigFile(projectConfigPath(ctx.cwd), read, warnings);
    if (project?.diffContext !== undefined) {
      config.diffContext = project.diffContext;
    }
  }

  return { config, warnings };
}
