# Features

Complete behavior reference for `agents-aliases`.

## Concepts

- **Concern** — a kind of agent content: `instructions`, `skills`, `rules`, `plugins`.
- **Canonical** — the one real file/directory a concern is wired to. Every other location becomes an alias or generated adapter.
- **Alias** — a relative symlink at a tool's expected path, pointing at the canonical.
- **Adapter** — a generated rule file: canonical body + tool-specific frontmatter + provenance marker.

## Detection matrix

`agents-aliases` scans these paths relative to the working directory (order = canonical preference):

| Concern | Preset id | Path | Tool | Wiring |
| --- | --- | --- | --- | --- |
| instructions | `codex` | `AGENTS.md` | Codex / AGENTS.md standard | symlink |
| instructions | `claude` | `CLAUDE.md` | Claude Code | symlink |
| instructions | `gemini` | `GEMINI.md` | Gemini CLI | symlink |
| instructions | `copilot` | `.github/copilot-instructions.md` | GitHub Copilot | symlink |
| skills | `skills-shared` | `.agents/skills` | Shared (.agents) | dir symlink |
| skills | `skills-claude` | `.claude/skills` | Claude Code | dir symlink |
| skills | `skills-codex` | `.codex/skills` | Codex | dir symlink |
| skills | `skills-opencode` | `.opencode/skills` | OpenCode | dir symlink |
| rules | `rules-cursor` | `.cursor/rules` | Cursor | adapter `.mdc` |
| rules | `rules-windsurf` | `.windsurf/rules` | Windsurf | adapter `.md` |
| rules | `rules-copilot` | `.github/instructions` | Copilot scoped | adapter `.instructions.md` |
| plugins | `plugins-claude` | `.claude/plugins` | Claude Code | dir symlink |

Each path is classified as: real file/dir (canonical candidate), working symlink, broken symlink, or missing. Real instruction files are content-hashed; real skill directories are tree-hashed (recursive, sorted, symlink-aware) to detect identical vs diverged copies.

## Wizard

Run bare (`npx agents-aliases`) for the interactive flow:

1. **Scan summary** — every non-missing path with its state.
2. **Per concern with detected content** — "Set up aliases for …?" (default yes). Concerns with nothing on disk are skipped.
3. **Canonical picker** — appears only when ≥ 2 real sources exist for a concern; options are annotated `content identical to other copies` / `has unique content`.
4. **Target multi-select** — all supported agents pre-checked; hints show each path's current state (`exists (will be replaced by alias)`, `already linked`, `not set up`). **Submitting empty = select everything.**
5. **Scaffold offer** — if no instruction file exists at all: create `AGENTS.md` stub and wire all agents to it.
6. **Preview plan** — every action with its link target and note; warnings and blocked items listed.
7. **Confirm → apply** — spinner + counts (`links created / replaced / repaired / generated`).

Cancelling any prompt exits cleanly without changes.

## Commands

### `init` (default)

Described above. Non-interactive when stdout/stdin is not a TTY, `CI` is set, or `--yes` is passed — defaults are applied: wire every detected concern, canonical = highest-preference source, targets = every other preset of the concern.

### `status`

Read-only wiring report grouped by concern: which path is the canonical candidate, which are aliases (and where they point), broken links (with repair hint), and generated files with their source.

### `sync`

Repair-only pass over existing wiring:

- **Broken symlinks** at a preset path → relinked to an existing canonical of the same concern (alias concerns only). With no canonical available, reported as unfixable.
- **Drifted generated files** (marker present, bytes differ from deterministic regeneration) → rewritten from their recorded source.
- Duplicate real files in alias concerns → warning (possible drift).
- Generated files whose source vanished → reported as unfixable (exit code 1).

`sync` never creates *new* wiring — re-run the wizard for that. Supports `--dry-run`.

### `check`

CI gate. Fails (exit 1) on:

- Broken aliases at any preset path.
- Duplicate real files in alias concerns (content may drift).
- Generated files that drifted from their source, reference a missing source, or lost their marker.
- Authored (marker-less) rule files in a non-canonical rules dir that shadow an adapter output name.

Outputs `check: all agent aliases are wired correctly.` and exit 0 otherwise. Never writes.

## Flags

| Flag | Effect |
| --- | --- |
| `-y, --yes` | Skip all prompts; accept defaults |
| `-a, --agents <csv>` | Restrict targets. Accepts preset ids (`rules-cursor`) or shortcuts: `claude`→claude+skills-claude+plugins-claude, `codex`→codex+skills-codex, `copilot`→copilot+rules-copilot, `cursor`, `windsurf`, `gemini`, `opencode`. Unknown ids abort with usage error (exit 2) |
| `--all` | Explicitly target every supported agent (same as defaults) |
| `--dry-run` | Preview only; filesystem untouched |

## Rule adapters

For each canonical rule file `<base>.md|.mdc|.instructions.md`, each target tool gets `targetFileName(base)`:

| Tool | Output name | Frontmatter emitted |
| --- | --- | --- |
| Cursor | `<base>.mdc` | `description`, `globs` (if known), `alwaysApply` (true when no globs known) |
| Windsurf | `<base>.md` | `trigger: glob` + `glob:` when globs known, else `trigger: always_on`; plus `description` |
| Copilot scoped | `<base>.instructions.md` | `applyTo` (from `applyTo`/`globs`, default `"**"`), optional `description` |

Carry-over: recognized keys in the canonical file's own frontmatter (`description`, `globs`, `applyTo`, `alwaysApply`, `trigger`) feed the mapping; unknown keys are dropped. `description` falls back to the first `# heading`, then the file base name.

Every adapter starts (after frontmatter) with the marker:

```
<!-- GENERATED by agents-aliases. Source: <canonical path>. DO NOT EDIT. -->
```

Generation is a pure function of `(source path, source bytes, format)` — running it twice yields identical bytes, which is what makes marker-free drift detection possible.

## Safety model

| Situation | Behavior |
| --- | --- |
| Target missing | Create alias/adapter |
| Working symlink already correct | Counted as no-op |
| Symlink pointing elsewhere | Repaired to canonical |
| Broken symlink | Repaired |
| Real duplicate, identical bytes/tree | Safe swap to symlink |
| Real duplicate, differs, git repo, path clean | Swap after preview ("recoverable via git history") |
| Real duplicate, differs, no git repo | **Blocked** — content would be lost |
| Real duplicate, differs, path has uncommitted changes | **Blocked** — commit/stash first |
| Differing skill/plugin trees | **Blocked** — manual merge required (never auto-merged) |
| Foreign rule files in a target rules dir | **Blocked** — merge into canonical first |
| Authored file (no marker) at an adapter's output path | **Blocked** — never overwritten; rename or merge it into the canonical |
| Rules dir already symlinked to canonical | Left alone with explanatory warning |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success / nothing to do / cancelled |
| `1` | Problems found: blocked items, apply errors, unfixable sync targets, check failures |
| `2` | Usage error: unknown command/flag, unknown `--agents` id |

## Requirements & limits

- Node.js ≥ 20 (macOS / Linux / Windows).
- Windows requires Developer Mode (or WSL/Admin) for symlink creation; the CLI surfaces actionable guidance on `EPERM`.
- One runtime dependency: `@clack/prompts`.
