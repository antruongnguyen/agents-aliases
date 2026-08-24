#!/usr/bin/env node
import { parseArgs } from "node:util";

import { KNOWN_COMMANDS } from "./presets.js";
import { runInit } from "./commands/init.js";
import { runStatus } from "./commands/status.js";
import { runSync } from "./commands/sync.js";
import { runCheck } from "./commands/check.js";

const VERSION = "0.1.0";

const HELP = `agents-aliases — one source of truth for every coding agent

Usage:
  agents-aliases [command] [options]

Commands:
  init      Auto-detect project setup and wire aliases interactively (default)
  status    Show detected wiring: canonicals, aliases, generated files
  sync      Repair broken aliases and regenerate drifted rule adapters
  check     Verify all wiring; non-zero exit code on problems (CI-friendly)

Options:
  -y, --yes       Skip prompts, use defaults (alias everything detected to every supported agent)
  -a, --agents    Comma-separated agent filter, e.g. claude,codex,cursor,windsurf,copilot,gemini,opencode
      --all       Alias every supported agent (same as accepting defaults)
      --dry-run   Preview the plan without touching the filesystem
  -h, --help      Show this help
  -V, --version   Show version

Examples:
  npx agents-aliases                  # interactive wizard
  npx agents-aliases --yes            # wire everything with defaults
  npx agents-aliases --agents claude,cursor --dry-run
  npx agents-aliases check            # in CI`;

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        yes: { type: "boolean", short: "y", default: false },
        all: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        agents: { type: "string", short: "a" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "V", default: false },
      },
    });
  } catch (err) {
    console.error(`Invalid arguments: ${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { positionals, values } = parsed;

  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log(`agents-aliases ${VERSION}`);
    return 0;
  }

  const command = positionals[0] ?? "init";
  if (!KNOWN_COMMANDS.includes(command as (typeof KNOWN_COMMANDS)[number])) {
    console.error(`Unknown command: ${command}\n\n${HELP}`);
    return 2;
  }
  if (positionals.length > 1) {
    console.error(`Unexpected extra arguments: ${positionals.slice(1).join(" ")}`);
    return 2;
  }

  const agentsFlag = typeof values.agents === "string" ? values.agents : undefined;

  switch (command) {
    case "status":
      return await runStatus();
    case "sync":
      return await runSync(Boolean(values["dry-run"]));
    case "check":
      return await runCheck();
    case "init":
    default:
      return await runInit({
        yes: Boolean(values.yes),
        all: Boolean(values.all),
        dryRun: Boolean(values["dry-run"]),
        agents: agentsFlag,
      });
  }
}

const invokedDirectly = process.argv[1] !== undefined;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
