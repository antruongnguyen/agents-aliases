export type ConcernKind = "instructions" | "skills" | "rules" | "plugins";

export type AdapterFormat = "mdc" | "copilot-instructions" | "windsurf";

export interface AgentPreset {
  id: string;
  tool: string;
  concern: ConcernKind;
  path: string;
  kind: "file" | "dir";
  adapter?: AdapterFormat;
}

export const CONCERN_LABELS: Record<ConcernKind, string> = {
  instructions: "Agent instructions",
  skills: "Agent skills",
  rules: "Agent rules",
  plugins: "Agent plugins",
};

export const CONCERN_ORDER: ConcernKind[] = [
  "instructions",
  "skills",
  "rules",
  "plugins",
];

export const PRESETS: AgentPreset[] = [
  {
    id: "codex",
    tool: "Codex / AGENTS.md standard",
    concern: "instructions",
    path: "AGENTS.md",
    kind: "file",
  },
  {
    id: "claude",
    tool: "Claude Code",
    concern: "instructions",
    path: "CLAUDE.md",
    kind: "file",
  },
  {
    id: "gemini",
    tool: "Gemini CLI",
    concern: "instructions",
    path: "GEMINI.md",
    kind: "file",
  },
  {
    id: "copilot",
    tool: "GitHub Copilot",
    concern: "instructions",
    path: ".github/copilot-instructions.md",
    kind: "file",
  },
  {
    id: "skills-shared",
    tool: "Shared (.agents)",
    concern: "skills",
    path: ".agents/skills",
    kind: "dir",
  },
  {
    id: "skills-claude",
    tool: "Claude Code",
    concern: "skills",
    path: ".claude/skills",
    kind: "dir",
  },
  {
    id: "skills-codex",
    tool: "Codex",
    concern: "skills",
    path: ".codex/skills",
    kind: "dir",
  },
  {
    id: "skills-opencode",
    tool: "OpenCode",
    concern: "skills",
    path: ".opencode/skills",
    kind: "dir",
  },
  {
    id: "rules-cursor",
    tool: "Cursor",
    concern: "rules",
    path: ".cursor/rules",
    kind: "dir",
    adapter: "mdc",
  },
  {
    id: "rules-windsurf",
    tool: "Windsurf",
    concern: "rules",
    path: ".windsurf/rules",
    kind: "dir",
    adapter: "windsurf",
  },
  {
    id: "rules-copilot",
    tool: "GitHub Copilot (scoped)",
    concern: "rules",
    path: ".github/instructions",
    kind: "dir",
    adapter: "copilot-instructions",
  },
  {
    id: "plugins-claude",
    tool: "Claude Code",
    concern: "plugins",
    path: ".claude/plugins",
    kind: "dir",
  },
];

export function presetsByConcern(concern: ConcernKind): AgentPreset[] {
  return PRESETS.filter((p) => p.concern === concern);
}

export function findPreset(id: string): AgentPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}

export function findPresetByPath(posixPath: string): AgentPreset | undefined {
  return PRESETS.find((p) => p.path === posixPath);
}

const AGENT_SHORTCUTS: Record<string, string[]> = {
  claude: ["claude", "skills-claude", "plugins-claude"],
  codex: ["codex", "skills-codex"],
  gemini: ["gemini"],
  copilot: ["copilot", "rules-copilot"],
  cursor: ["rules-cursor"],
  windsurf: ["rules-windsurf"],
  opencode: ["skills-opencode"],
};

export function knownAgentTokens(): Set<string> {
  const out = new Set<string>(Object.keys(AGENT_SHORTCUTS));
  for (const p of PRESETS) out.add(p.id);
  return out;
}

export function parseAgentList(csv: string): { ids: Set<string>; unknown: string[] } {
  const known = knownAgentTokens();
  const ids = new Set<string>();
  const unknown: string[] = [];
  for (const raw of csv.split(",")) {
    const token = raw.trim().toLowerCase();
    if (!token) continue;
    const expanded = AGENT_SHORTCUTS[token];
    if (expanded) {
      for (const id of expanded) ids.add(id);
    } else if (known.has(token)) {
      ids.add(token);
    } else {
      unknown.push(token);
    }
  }
  return { ids, unknown };
}

export function expandAgentList(csv: string): Set<string> {
  return parseAgentList(csv).ids;
}

export const KNOWN_COMMANDS = ["init", "status", "sync", "check"] as const;

export const SCAFFOLD_STUB = `# Project Instructions

Instructions for AI coding agents working in this repository.

## Build & test

Describe the commands agents should use to build and test this project.

## Conventions

Describe the conventions agents must follow.
`;
