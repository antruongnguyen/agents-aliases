# Decisions

Design decisions recorded as short ADRs. Status: all **accepted** (v0.1.0).

---

## ADR-001 — No configuration file; the filesystem is the only state

**Context.** The original design used `agents-aliases.json` to declare canonical → target wiring. The maintainer wanted a zero-config, detect-and-ask experience instead: scan, confirm, pick agents, default to everything.

**Decision.** Drop the config file entirely. Intent is inferred from what exists on disk: symlinks at preset paths and marker comments inside generated files.

**Consequences.**
- ✅ Nothing to keep in sync, nothing to validate, nothing for CI to drift against; uninstalling is deleting symlinks.
- ✅ `check`/`sync` work in any fresh clone with no setup.
- ❌ The tool can verify only wiring that exists — it cannot remind you about aliases you never created. New wiring requires re-running the wizard (`sync` is repair-only by design).
- ❌ "Which agents did I choose?" is answered by inspecting links, not reading a manifest.

---

## ADR-002 — Symlinks over copies for same-format content

**Context.** Alternatives were copy+sync (works on Windows without privileges) or pointer stubs (`See AGENTS.md`).

**Decision.** Relative symlinks are the primary mechanism for instruction files, skill dirs, and plugin dirs.

**Consequences.**
- ✅ Single real file per concern; zero propagation delay; git records links natively (mode `120000`) so clones reproduce wiring.
- ✅ Claude Code's own docs endorse `ln -s AGENTS.md CLAUDE.md`; OS-level link following means tools need no awareness.
- ❌ Windows needs Developer Mode/WSL/Admin — mitigated with an actionable error message rather than silent fallback (copy-fallback deferred until requested).
- Rejected: pointer stubs — thin files are unreliable (agents may not follow the reference) and reintroduce duplication in spirit.

---

## ADR-003 — Rules get generated adapters, not symlinks

**Context.** Rule formats diverge: Cursor MDC requires `description`/`globs`/`alwaysApply`, Copilot scoped instructions require `applyTo`, Windsurf uses `trigger`. Symlinking a plain `.md` would present the wrong format to these tools.

**Decision.** For rules, generate a file per target: mapped frontmatter + canonical body + provenance marker.

**Consequences.**
- ✅ Each tool receives valid metadata it can actually act on.
- ❌ Generated files are duplicates by nature — mitigated by determinism (see ADR-004), markers that prevent accidental edits, and `check` catching manual edits byte-for-byte.
- Edge: if a rules dir is already symlinked to the canonical dir, generation is skipped with a warning instead of breaking existing working wiring.

---

## ADR-004 — Deterministic generation replaces lockfiles/state

**Context.** Sync tools usually store checksums or manifests to detect drift.

**Decision.** `generateAdapter(sourcePath, sourceBytes, format)` is a pure function; expected bytes are recomputed and compared on every `check`/`sync`. The generated file itself carries its provenance in the marker line.

**Consequences.**
- ✅ No state file, no staleness of the state file, trivially debuggable ("regenerate and diff").
- ✅ Markers double as safety rails: files without a marker are treated as foreign and never overwritten.
- ❌ Requires frontmatter/body serialization to be stable — covered by explicit determinism tests.

---

## ADR-005 — Interactive-first CLI with @clack/prompts as the sole dependency

**Context.** The product decision was "auto-detect, ask, default to all". That requires quality TUI primitives (confirm/select/multi-select/spinner). Zero-dep hand-rolled prompts would cost ~300 lines of fragile terminal handling for worse UX.

**Decision.** One runtime dependency (`@clack/prompts`, ~small, ESM). All other functionality uses Node built-ins (`node:fs`, `node:path`, `node:util#parseArgs`, `node:crypto`, `node:child_process`).

**Consequences.**
- ✅ Fast installs, small tarball (~13 kB packed).
- ✅ Prompts isolated in `ui/prompts.ts`; wizard logic is testable via mocks (no TTY needed).
- ❌ TUI behavior under exotic terminals depends on clack; accepted trade-off vs maintaining raw-mode code.

---

## ADR-006 — Canonical preference order is fixed, not configured

**Context.** With multiple real copies of a concern, one must become canonical. Options: ask always, or encode a sensible default order.

**Decision.** Preset array order defines preference: instructions prefer `AGENTS.md` (the cross-tool standard, read by Codex/Cursor/Copilot-agent/Windsurf/Zed/Jules), skills prefer `.agents/skills` (the emerging cross-client convention), rules prefer `.cursor/rules`. The picker only appears when ≥ 2 real sources exist; non-interactive mode takes the first candidate silently.

**Consequences.**
- ✅ Sensible defaults align with ecosystem convergence; if Claude Code ever adopts AGENTS.md, dropping one spoke suffices.
- ❌ Users who want CLAUDE.md as canonical must answer one prompt (or reorder presets via PR).

---

## ADR-007 — Destructive operations require recoverability

**Context.** Replacing `CLAUDE.md` (with unique content) by a symlink destroys the working-tree copy. Doing that silently would be data loss.

**Decision.** Replacement of a differing duplicate is allowed only when the old content is recoverable: a git repo exists AND the specific path has no uncommitted changes AND the plan was previewed/confirmed. Without git, differing duplicates are hard-blocked. Identical-byte duplicates are always safe-swapped. Skills/plugin trees with differing contents are never auto-merged — blocked for manual merge regardless of git state.

**Consequences.**
- ✅ Worst case after any run: `git checkout -- <path>` restores everything.
- ✅ Gates live in `plan()`, so wizard preview, `--yes`, and dry-run all inherit identical semantics.
- ❌ Fresh non-git projects can't be fully wired until they commit or merge manually — deliberate friction.

---

## ADR-008 — `check` verifies existence-shaped facts, not intent

**Context.** Should `check` fail when a *supported agent* has no alias yet?

**Decision.** `check` validates only wiring that claims to exist: broken links, duplicate real files where an alias was expected, drifted/orphaned/marker-less generated files. Missing optional aliases are not failures.

**Consequences.**
- ✅ Safe to add repo-wide from day one without forcing every contributor/team onto every agent.
- ✅ No false positives in projects that intentionally use a subset of tools.
- ❌ Won't catch "we forgot Cursor" — that's a human/wizard concern.

---

## ADR-009 — Exit-code contract: 0 / 1 / 2

**Decision.** `0` = success, nothing-to-do, or user cancellation. `1` = problems found (blocked items, apply errors, unfixable sync targets, check failures). `2` = usage errors (unknown command/flag/agent id).

**Consequences.**
- ✅ CI recipes are one-liners: `npx agents-aliases check`.
- ✅ Cancelled wizards don't page anyone (Ctrl-C is not an incident).

---

## ADR-010 — TypeScript ESM on Node ≥ 20, bundled to a single file

**Decision.** Strict TypeScript compiled by tsdown to one ESM bundle (~39 kB) targeting Node ≥ 20 (maintenance LTS floor at time of writing). Tests via vitest; lint via oxlint; formatting via prettier.

**Consequences.**
- ✅ Single-artifact bin keeps `npx` cold-start fast and the published tree trivial.
- ✅ `strict` + `noUncheckedIndexedAccess` caught several real bugs during development.
- ❌ Drops pre-20 environments (Node 16/18 EOL long before v0.1).

---

## Deferred (not decided for v1)

- Copy-fallback mode for Windows without Developer Mode.
- Watch mode / automatic re-sync on file change.
- Home-directory scopes (`~/.claude`, `~/.agents`) and multi-repo anchors.
- Plugin format conversion across tools (v1 shares plugin directories only).
- Monorepo workspace auto-discovery (per-package root invocation works today).
