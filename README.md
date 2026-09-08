# agents-aliases ![NPM Version](https://img.shields.io/npm/v/agents-aliases)

One source of truth for every AI coding agent — zero config files.

`agents-aliases` scans your project, then wires **symlinks** between the instruction files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`) and skills/plugin directories (`.agents/skills`, `.claude/skills`, `.cline/skills`, …), and generates format-correct **rule adapters** for tools whose frontmatter differs (Cursor, Windsurf, Copilot). Rules directories that share the same format as the canonical are wired as a **relative directory symlink** instead (e.g. Claude↔Cline, both plain-md with `paths` frontmatter). Pick your agents once; edit one file per concern; every agent reads the same source.

```bash
npx agents-aliases
```

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/features.md](docs/features.md) | Full feature reference: detection matrix, commands, flags, adapter formats |
| [docs/architectures.md](docs/architectures.md) | Module map, data flow, core type contracts, testing strategy |
| [docs/decisions.md](docs/decisions.md) | Design decisions and their rationale (ADRs) |

## Why

| Tool | What it reads |
| --- | --- |
| Codex / OpenAI | `AGENTS.md` |
| Claude Code | `CLAUDE.md` (does **not** read `AGENTS.md`) |
| Gemini CLI | `GEMINI.md` |
| GitHub Copilot | `.github/copilot-instructions.md` (+ scoped `.github/instructions/*.instructions.md`) |
| Cursor | `.cursor/rules/*.mdc` |
| Windsurf | `.windsurf/rules/*.md` |
| OpenCode | `AGENTS.md` |
| Cline | `.cline/rules/*.md`, `.cline/skills` |

Without help, teams copy-paste the same content into several of these and watch them drift apart. With `agents-aliases`, there is exactly one real file per concern.

## Alias matrix

What gets wired, per agent and concern:

| Agent | Instructions | Skills | Rules | Plugins |
| --- | --- | --- | --- | --- |
| **Codex** | `AGENTS.md` — canonical | `.codex/skills` → link | — | — |
| **Claude Code** | `CLAUDE.md` → link | `.claude/skills` → link | `.claude/rules/<name>.md` — adapter · preferred canonical | `.claude/plugins` — canonical |
| **Gemini CLI** | `GEMINI.md` → link | — | — | — |
| **GitHub Copilot** | `.github/copilot-instructions.md` → link | — | `.github/instructions/<name>.instructions.md` — adapter | — |
| **Cursor** | reads `AGENTS.md` (no extra file) | — | `.cursor/rules/<name>.mdc` — adapter | — |
| **Windsurf** | reads `AGENTS.md` (no extra file) | — | `.windsurf/rules/<name>.md` — adapter | — |
| **OpenCode** | reads `AGENTS.md` (no extra file) | `.opencode/skills` → link | — | — |
| **Cline** | — | `.cline/skills` → link | `.cline/rules` → dir symlink (same format as Claude); else adapter | — |

\* Codex, Cursor, Windsurf, Zed, Jules and the Copilot coding agent all read `AGENTS.md` natively — the canonical *is* their alias; only Claude Code and Gemini CLI need extra files.

Legend:

| Marking | Meaning |
| --- | --- |
| **canonical** | The one real file/dir you edit (default per concern below) |
| `→ link` | Relative symlink created at this path, pointing at the canonical |
| **adapter** | Generated file: canonical body + that tool's required frontmatter, marker-stamped |
| — | Not currently wired |

Default wiring created by "select all":

| Concern | Canonical (you edit) | Aliases / adapters created |
| --- | --- | --- |
| Instructions | `AGENTS.md` | `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md` (3 symlinks) |
| Skills | `.agents/skills` | `.claude/skills`, `.codex/skills`, `.opencode/skills`, `.cline/skills` (4 dir symlinks) |
| Rules | first existing of `.claude/rules` › `.cursor/rules` › `.windsurf/rules` › `.github/instructions` › `.cline/rules` | adapters in the other four dirs; same-format targets (Claude↔Cline) are symlinked instead |
| Plugins | `.claude/plugins` | custom dir targets |

Resulting project:

```
AGENTS.md                                  # edit only this
CLAUDE.md              -> AGENTS.md
GEMINI.md              -> AGENTS.md
.github/copilot-instructions.md -> ../AGENTS.md
.agents/skills/                            # canonical skills
.claude/skills         -> ../.agents/skills
.codex/skills          -> ../.agents/skills
.opencode/skills       -> ../.agents/skills
.cline/skills          -> ../.agents/skills
.claude/rules/review.md                    # generated adapter (plain md, paths frontmatter)
.cursor/rules/review.mdc                   # generated adapter w/ MDC frontmatter
.windsurf/rules/review.md                  # generated adapter
.github/instructions/review.instructions.md# generated adapter
.cline/rules              -> ../.claude/rules   # symlink (same format as Claude)
```

## How it works

- **Instructions / skills / plugins** → relative **symlinks** to a canonical file or directory you pick. Git tracks symlinks natively (`120000`), so teammates get identical wiring on clone.
- **Rules** → generated adapters: your canonical rule file's body plus each tool's required frontmatter (`paths` for Claude Code, `globs`/`alwaysApply` for Cursor MDC, `applyTo` for Copilot, `trigger` for Windsurf), stamped with a `<!-- GENERATED by agents-aliases -->` marker. Exception: a rules target whose adapter format matches the canonical's (e.g. Claude↔Cline, both plain-md with `paths` frontmatter) is wired as a **relative directory symlink** instead of a generated copy.
- **No state file.** The filesystem is the only source of truth. `status`, `sync` and `check` derive everything from symlinks and markers.

See [docs/features.md](docs/features.md) for the complete behavior reference and [docs/decisions.md](docs/decisions.md) for why it is built this way.

## Commands

| Command | What it does |
| --- | --- |
| *(default)* | Interactive wizard: scans, asks which agents to wire (one picker, **enter = all**), resolves any file conflicts (skip/overwrite), previews, applies |
| `status` | Report canonicals, aliases, broken links, generated files |
| `sync` | Repair broken aliases, regenerate drifted rule adapters |
| `check` | Read-only CI gate — exits non-zero on broken/duplicated/drifted wiring |

### Flags

```
-y, --yes      Skip prompts: wire everything detected to every supported agent
-a, --agents   Filter targets: claude,codex,gemini,copilot,cursor,windsurf,opencode,cline
    --all      Widen targets to all agents (overrides --agents; no-op alone)
    --dry-run  Preview without touching anything
-h, --help     Help        -V, --version   Version
```

Exit codes: `0` clean · `1` problems found · `2` usage error.

## Safety

- Never overwrites a real file silently: identical duplicates are safe-swapped; a differing file becomes a **conflict** you resolve per file in the interactive wizard (skip or overwrite, with a warning when there's no git safety net). Non-interactively (`--yes`/CI), a differing instruction file in a clean git repo is replaced (history keeps the old content) and every other conflict is reported and left untouched.
- Skills/rule directories with genuinely different contents are never merged automatically — the wizard offers skip/overwrite (overwrite replaces the whole tree); non-interactively they're reported as conflicts.
- Generated files carry a marker and are regenerated deterministically, so drift is detectable byte-for-byte. Authored files without the marker are never overwritten.
- Non-git projects get read-only treatment when content would be lost.

## CI recipe

```yaml
# .github/workflows/agents.yml
- run: npx agents-aliases@latest check
```

## Caveats

- **Windows**: creating symlinks needs Developer Mode (or WSL/Admin). The CLI explains this if it hits `EPERM`.
- **Cursor MDC**: adapters emit standard `description`/`globs`/`alwaysApply`; verify rule activation in Cursor after first sync.
- Plugins are shared at the directory level only; plugin formats are not converted across tools.

## Development

```bash
pnpm install
pnpm test        # build + vitest (unit, planner, wizard, CLI smoke)
pnpm verify      # lint + typecheck + test + build (same gate as CI/release)
pnpm lint        # oxlint
pnpm typecheck   # tsc --noEmit
pnpm build       # tsdown -> dist/cli.js
```

Releasing: push a version tag — `.github/workflows/release.yml` verifies, builds, publishes to npm and attaches the tarball to a GitHub release:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

Prerequisite: a one-time **npm trusted publisher (OIDC)** configuration for this package, pointing at `release.yml`. No `NPM_TOKEN` secret is needed — provenance is signed automatically.

Project layout:

```
src/
├── cli.ts              # arg parsing + dispatch
├── detect.ts           # filesystem scanner -> Detection
├── presets.ts          # agent/tool registry (the only tool knowledge)
├── engine/
│   ├── planner.ts      # Detection + Choices -> Plan (pure)
│   ├── symlink.ts      # relative link primitives
│   └── rules.ts        # deterministic adapter generation
├── commands/           # init (wizard), status, sync, check, preview
├── ui/                 # thin @clack/prompts layer: prompts, search-multiselect, summary
└── util/fs.ts          # path classification, hashing, git status
test/                   # vitest: unit + planner + wizard + CLI smoke
```

MIT © 2026
