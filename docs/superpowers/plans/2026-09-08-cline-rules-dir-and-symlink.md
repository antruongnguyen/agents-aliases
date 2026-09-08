# Cline `.cline/rules` + Same-Format Rule Symlinks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Cline rules to `.cline/rules`, wire same-adapter-format rule targets (Claude↔Cline) as directory symlinks instead of generated copies, and auto-migrate legacy `.clinerules/` with git-safety.

**Architecture:** `presets.ts` is the sole tool-knowledge source; the `rules-cline` path changes there. In `planner.ts`, the alias-target state→action decision is extracted into a shared `planDirSymlinkTarget` helper; `planRulesConcern` partitions targets by adapter format — same-format targets go through the symlink helper, differing formats keep the existing per-file `generateAdapter` path. A new git-gated `migrate` action moves `.clinerules/` → `.cline/rules/`, planned before wiring and executed by the sole writer `applyPlan`.

**Tech Stack:** TypeScript (strict, ESM, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`), Node built-ins only, vitest, pnpm, tsdown.

**Spec:** `docs/superpowers/specs/2026-09-08-cline-rules-dir-and-symlink-design.md`

## Global Constraints

- One runtime dependency (`@clack/prompts`) + `picocolors`; everything else Node built-ins. Do not add dependencies.
- Symlinks are always **relative**, created via `createSymlink`/`replaceWithSymlink` (temp-link → rename); Windows `EPERM`/`EACCES` surfaces as `WindowsSymlinkError`.
- All safety gates live in `plan()`, never in `applyPlan()`. Replacing a differing real dir requires `isGitRepo && !dirtyPaths.has(path)`; else it is a `conflict`/`blocked`, never a silent overwrite.
- `generateAdapter` output must stay byte-stable (`test/rules.test.ts`); link targets never call it.
- Exit codes contractual: `0` clean · `1` problems · `2` usage. Node >= 20.
- `pnpm test` runs `pnpm build` first (smoke tests exec `dist/cli.js`); run `pnpm verify` before finishing.
- Test helpers live in `test/helpers.js`: `makeProject()` → temp root; `writeRel(root, rel, content)`; `linkRel(root, targetRel, linkText)`. Local test helpers in `test/planner.test.ts`: `symlinkActions(p, targetPath?)`, `generateActions(p)`, `ALL(detection)`.

---

### Task 1: Move `rules-cline` preset to `.cline/rules`

**Files:**
- Modify: `src/presets.ts:124-131` (the `rules-cline` object)
- Test: `test/presets.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `findPreset("rules-cline").path === ".cline/rules"` (adapter `"claude"`, kind `"dir"`), consumed by all later tasks.

- [ ] **Step 1: Write the failing test**

Add to `test/presets.test.ts`:

```typescript
it("wires Cline rules at .cline/rules with the claude adapter", () => {
  const p = findPreset("rules-cline");
  expect(p?.path).toBe(".cline/rules");
  expect(p?.adapter).toBe("claude");
  expect(p?.kind).toBe("dir");
});

it("cline shortcut still expands to skills-cline + rules-cline", () => {
  const { ids } = parseAgentList("cline");
  expect([...ids].sort()).toEqual(["rules-cline", "skills-cline"]);
});
```

Ensure the file imports `findPreset` and `parseAgentList` from `../src/presets.js` (add to the existing import if missing).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run -t "wires Cline rules at .cline/rules"`
Expected: FAIL — `.clinerules` !== `.cline/rules`.

- [ ] **Step 3: Change the preset path**

In `src/presets.ts`, the `rules-cline` entry:

```typescript
  {
    id: "rules-cline",
    tool: "Cline",
    concern: "rules",
    path: ".cline/rules",
    kind: "dir",
    adapter: "claude",
  },
```

(Only the `path` line changes: `.clinerules` → `.cline/rules`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run -t "wires Cline rules at .cline/rules" && pnpm vitest run -t "cline shortcut still expands"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/presets.ts test/presets.test.ts
git commit -m "feat: wire Cline rules at .cline/rules instead of .clinerules"
```

---

### Task 2: Extract `planDirSymlinkTarget` shared helper

Refactor-only. `planAliasConcern`'s per-target `switch` becomes a reusable helper so rules link-targets can share it. Behavior of instructions/skills/plugins must not change.

**Files:**
- Modify: `src/engine/planner.ts` (extract from `planAliasConcern` body, lines 162-226)
- Test: `test/planner.test.ts` (characterization test added first — `planAliasConcern` has no direct coverage)

**Interfaces:**
- Consumes: `Detection`, a target `AgentPreset`, a canonical `AgentPreset`, `Plan`.
- Produces:
  ```typescript
  function planDirSymlinkTarget(
    detection: Detection,
    target: AgentPreset,
    canonical: AgentPreset,
    concern: ConcernKind,
    plan: Plan,
  ): void
  ```
  Pushes `symlink`/conflict/noop into `plan` per the existing state rules. Consumed by Task 3.

- [ ] **Step 1: Write a characterization test locking current alias behavior**

Add to `test/planner.test.ts` inside `describe("plan: skills", …)`:

```typescript
it("repairs a skill symlink pointing elsewhere and noops a correct one", async () => {
  const root = await makeProject();
  await writeRel(root, ".agents/skills/a/SKILL.md", "a\n");
  await linkRel(root, ".claude/skills", ".agents/skills");        // correct
  await linkRel(root, ".codex/skills", "../wrong");               // wrong target
  const d = await detect(root);
  const p = await plan(d, ALL(d));

  expect(symlinkActions(p, ".codex/skills")[0]?.op).toBe("repair");
  expect(symlinkActions(p, ".claude/skills")).toHaveLength(0); // noop, no action
  expect(p.noopCount).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 2: Run it to verify it passes on current code (characterization baseline)**

Run: `pnpm vitest run -t "repairs a skill symlink pointing elsewhere"`
Expected: PASS (this documents behavior before the refactor).

- [ ] **Step 3: Extract the helper**

In `src/engine/planner.ts`, add above `planAliasConcern`:

```typescript
function planDirSymlinkTarget(
  detection: Detection,
  target: AgentPreset,
  canonical: AgentPreset,
  concern: ConcernKind,
  plan: Plan,
): void {
  const { root } = detection;
  const state = detection.concerns[concern].states.get(target.id);

  switch (state?.type) {
    case undefined:
    case "missing":
      plan.actions.push({
        kind: "symlink",
        op: "create",
        targetPath: target.path,
        canonicalPath: canonical.path,
      });
      break;
    case "broken-symlink":
      plan.actions.push({
        kind: "symlink",
        op: "repair",
        targetPath: target.path,
        canonicalPath: canonical.path,
        note: `was a broken link -> ${state.linkText ?? "?"}`,
      });
      break;
    case "symlink-file":
    case "symlink-dir":
      if (linkPointsTo(root, target.path, state.linkText, canonical.path)) {
        plan.noopCount += 1;
      } else {
        plan.actions.push({
          kind: "symlink",
          op: "repair",
          targetPath: target.path,
          canonicalPath: canonical.path,
          note: `was linked -> ${state.linkText ?? "?"}`,
        });
      }
      break;
    case "file":
    case "dir":
      if (identicalContent(detection, target.path, canonical.path)) {
        plan.actions.push({
          kind: "symlink",
          op: "replace",
          targetPath: target.path,
          canonicalPath: canonical.path,
          note: "content identical to canonical",
        });
      } else {
        plan.conflicts.push({
          targetPath: target.path,
          canonicalPath: canonical.path,
          concern,
          kind: state.type,
          gitRecoverable: detection.isGitRepo && !detection.dirtyPaths.has(target.path),
        });
      }
      break;
  }
}
```

Add `type AgentPreset` to the existing `../presets.js` import in `planner.ts`.

- [ ] **Step 4: Rewrite `planAliasConcern`'s loop to call the helper**

Replace the `for (const targetId of choice.targetIds) { … switch … }` block (lines 162-226) with:

```typescript
  for (const targetId of choice.targetIds) {
    if (targetId === canonical.id) continue;
    const target = findPreset(targetId);
    if (!target) continue;
    planDirSymlinkTarget(detection, target, canonical, concern, plan);
  }
```

- [ ] **Step 5: Run tests to verify no behavior change**

Run: `pnpm build && pnpm vitest run test/planner.test.ts`
Expected: PASS — all existing instructions/skills tests plus the new characterization test.

- [ ] **Step 6: Commit**

```bash
git add src/engine/planner.ts test/planner.test.ts
git commit -m "refactor: extract planDirSymlinkTarget from planAliasConcern"
```

---

### Task 3: Same-adapter-format rule targets become directory symlinks

`planRulesConcern` partitions targets: `target.adapter === canonical.adapter` → symlink via the Task 2 helper; otherwise → existing per-file generation.

**Files:**
- Modify: `src/engine/planner.ts` (`planRulesConcern`, lines 253-299 — the target loop)
- Test: `test/planner.test.ts` (`describe("plan: rules", …)`)

**Interfaces:**
- Consumes: `planDirSymlinkTarget` (Task 3 uses it for link targets), `findPreset`, preset `adapter` field.
- Produces: no new exported symbols; changes which `Action`s `plan()` emits for same-format rule targets.

- [ ] **Step 1: Update the two existing rules tests that assumed `.clinerules` generation**

In `test/planner.test.ts`, the test `"generates adapters for missing rule dirs with correct names"` currently expects `.clinerules/review.md` among generated targets and `summary.generated` of 4. With Claude canonical and Cline sharing the `claude` format, Cline is now a **symlink**, not generated. Change that test to:

```typescript
  it("generates adapters for differing formats and symlinks same-format targets", async () => {
    const root = await makeProject();
    await writeRel(root, ".claude/rules/review.md", "---\npaths:\n  - \"src/**\"\n---\nDo review.\n");
    const d = await detect(root);
    const p = await plan(d, ALL(d));

    // Claude is canonical (first existing rules preset). Cline shares the "claude"
    // adapter format, so it is symlinked, not generated.
    const generated = generateActions(p)
      .map((a) => a.targetPath)
      .sort();
    expect(generated).toEqual([
      ".cursor/rules/review.mdc",
      ".github/instructions/review.instructions.md",
      ".windsurf/rules/review.md",
    ]);

    const clineLink = symlinkActions(p, ".cline/rules")[0];
    expect(clineLink?.op).toBe("create");
    expect(clineLink?.canonicalPath).toBe(".claude/rules");

    const summary = await applyPlan(d, p, false);
    expect(summary.generated).toBe(3);
    expect(summary.created).toBe(1);
    const fspMod = await import("node:fs/promises");
    const link = await fspMod.readlink(path.join(root, ".cline/rules"));
    expect(link).toBe("../.claude/rules");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm build && pnpm vitest run -t "generates adapters for differing formats and symlinks same-format targets"`
Expected: FAIL — Cline still generated (no `.cline/rules` symlink action yet).

- [ ] **Step 3: Add the format partition to `planRulesConcern`**

In `src/engine/planner.ts`, inside `planRulesConcern`'s target loop, immediately after `const target = findPreset(targetId); if (!target || target.adapter === undefined) continue;` and before the existing `symlink-file`/`symlink-dir` handling, insert:

```typescript
    // Same adapter format as canonical: the two dirs are byte-compatible, so wire the
    // whole target dir as a relative symlink rather than copying per-file adapters.
    if (target.adapter === canonical.adapter) {
      const existing =
        scan.states.get(target.id)?.type === "dir"
          ? await listRuleFiles(path.resolve(detection.root, target.path))
          : [];
      const authored = existing.filter(
        (name) => !canonicalBases.has(stripExt(name)),
      );
      if (authored.length > 0) {
        plan.blocked.push(
          `${target.path}: contains its own rule files (${authored.join(", ")}); merge into ${canonical.path}, then re-run.`,
        );
        continue;
      }
      planDirSymlinkTarget(detection, target, canonical, "rules", plan);
      continue;
    }
```

The existing `symlink-*`, `foreign`, and `compareGenerated` logic below stays and now runs only for differing-format targets.

- [ ] **Step 4: Run the rules tests to verify they pass**

Run: `pnpm build && pnpm vitest run test/planner.test.ts`
Expected: PASS — new same-format test passes; the other three rules tests (`.cursor` canonical cases) still pass because they use differing formats.

- [ ] **Step 5: Add a reverse-direction test (Cline canonical → Claude symlinked)**

```typescript
  it("symlinks Claude to Cline when Cline is canonical", async () => {
    const root = await makeProject();
    await writeRel(root, ".cline/rules/review.md", "---\npaths:\n  - \"src/**\"\n---\nbody\n");
    const d = await detect(root);
    // Cline is the only existing rules dir → canonical.
    const p = await plan(d, ALL(d));
    const claudeLink = symlinkActions(p, ".claude/rules")[0];
    expect(claudeLink?.op).toBe("create");
    expect(claudeLink?.canonicalPath).toBe(".cline/rules");
  });
```

Run: `pnpm build && pnpm vitest run -t "symlinks Claude to Cline when Cline is canonical"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/engine/planner.ts test/planner.test.ts
git commit -m "feat: symlink same-adapter-format rule dirs instead of copying"
```

---

### Task 4: `.clinerules` → `.cline/rules` migration action

A new git-gated `migrate` action, planned before rules wiring and executed by `applyPlan`.

**Files:**
- Modify: `src/engine/planner.ts` (add `Action` variant, a `planClinerulesMigration` function called at the top of `plan()`, apply logic in `applyPlan`, and `describeAction`)
- Modify: `src/ui/summary.ts` (surface migration in the setup summary)
- Test: `test/planner.test.ts`

**Interfaces:**
- Consumes: `Detection` (needs `.clinerules` FS state — see Step 1 detection note).
- Produces:
  ```typescript
  // new Action variant:
  | { kind: "migrate"; op: "move"; fromDir: string; toDir: string; files: string[] }
  ```
  `applyPlan` moves each file from `fromDir` to `toDir`, then removes `fromDir`. `summary.migrated` counts it.

- [ ] **Step 1: Detect `.clinerules` (not a preset — detect it directly in the migration planner)**

`.clinerules` is intentionally not in `PRESETS`. `planClinerulesMigration` reads the FS directly. Add to `src/engine/planner.ts`:

```typescript
const CLINERULES_LEGACY = ".clinerules";
const CLINE_RULES = ".cline/rules";

async function planClinerulesMigration(detection: Detection, plan: Plan): Promise<void> {
  const legacyAbs = path.resolve(detection.root, CLINERULES_LEGACY);
  const legacyFiles = await listRuleFiles(legacyAbs);
  if (legacyFiles.length === 0) return; // nothing to migrate

  const targetAbs = path.resolve(detection.root, CLINE_RULES);
  const targetExists = (await listRuleFiles(targetAbs)).length > 0;
  if (targetExists) {
    plan.warnings.push(
      `Both ${CLINERULES_LEGACY} and ${CLINE_RULES} exist; ${CLINERULES_LEGACY} is deprecated — merge it into ${CLINE_RULES} and delete it.`,
    );
    return;
  }

  const gitRecoverable =
    detection.isGitRepo &&
    ![...detection.dirtyPaths].some((p) => p === CLINERULES_LEGACY || p.startsWith(`${CLINERULES_LEGACY}/`));
  if (!gitRecoverable) {
    plan.blocked.push(
      `${CLINERULES_LEGACY}: cannot migrate to ${CLINE_RULES} — needs a clean git repo so the move stays recoverable. Commit or stash, then re-run.`,
    );
    return;
  }

  plan.actions.push({
    kind: "migrate",
    op: "move",
    fromDir: CLINERULES_LEGACY,
    toDir: CLINE_RULES,
    files: legacyFiles,
  });
}
```

Note: `listRuleFiles` returns only top-level `.md`/`.mdc` names (matches how Cline rule dirs are used). If nested rule files must move, this is a known limitation — the spec scopes migration to rule files, and `.clinerules` is flat in practice.

- [ ] **Step 2: Write the failing tests**

```typescript
describe("plan: .clinerules migration", () => {
  it("migrates .clinerules to .cline/rules in a clean repo", async () => {
    const root = await makeProject({ git: true }); // see helper note below
    await writeRel(root, ".clinerules/review.md", "---\npaths:\n  - \"src/**\"\n---\nbody\n");
    const d = await detect(root);
    const p = await plan(d, ALL(d));

    const mig = p.actions.find((a) => a.kind === "migrate");
    expect(mig).toMatchObject({ fromDir: ".clinerules", toDir: ".cline/rules", files: ["review.md"] });

    await applyPlan(d, p, false);
    const fspMod = await import("node:fs/promises");
    const moved = await fspMod.readFile(path.join(root, ".cline/rules/review.md"), "utf8");
    expect(moved).toContain("body");
    await expect(fspMod.stat(path.join(root, ".clinerules"))).rejects.toThrow(/ENOENT/);
  });

  it("warns instead of migrating when .cline/rules already exists", async () => {
    const root = await makeProject({ git: true });
    await writeRel(root, ".clinerules/old.md", "old\n");
    await writeRel(root, ".cline/rules/new.md", "new\n");
    const d = await detect(root);
    const p = await plan(d, ALL(d));
    expect(p.actions.some((a) => a.kind === "migrate")).toBe(false);
    expect(p.warnings.join("\n")).toContain(".clinerules is deprecated");
  });

  it("blocks migration when the repo is not clean", async () => {
    const root = await makeProject(); // no git → not recoverable
    await writeRel(root, ".clinerules/review.md", "body\n");
    const d = await detect(root);
    const p = await plan(d, ALL(d));
    expect(p.actions.some((a) => a.kind === "migrate")).toBe(false);
    expect(p.blocked.join("\n")).toContain(".clinerules: cannot migrate");
  });
});
```

**Helper note:** confirm whether `makeProject` accepts a `{ git: true }` option (it must produce `isGitRepo === true` with no dirty paths under `.clinerules`). Check `test/helpers.ts`; if no git option exists, add one that runs `git init` + `git add -A && git commit` in the temp root, OR stage the file so `dirtyPaths` excludes it. Whichever the helper already supports for the existing git-gated tests — reuse that exact pattern rather than inventing a new one.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm build && pnpm vitest run test/planner.test.ts -t "migration"`
Expected: FAIL — no `migrate` action, no warning/blocked text.

- [ ] **Step 4: Add the `Action` variant and wire the planner**

In `src/engine/planner.ts`, extend the `Action` union:

```typescript
  | { kind: "migrate"; op: "move"; fromDir: string; toDir: string; files: string[] };
```

Call the migration at the top of `plan()`, before rules wiring so `.cline/rules` is populated first:

```typescript
export async function plan(detection: Detection, choices: Choices): Promise<Plan> {
  const result = emptyPlan();
  await planClinerulesMigration(detection, result);
  await planAliasConcern(detection, choices.instructions, "instructions", result);
  await planAliasConcern(detection, choices.skills, "skills", result);
  await planAliasConcern(detection, choices.plugins, "plugins", result);
  await planRulesConcern(detection, choices.rules, result);
  return result;
}
```

- [ ] **Step 5: Add `migrated` to `ApplySummary` and apply logic**

Extend `ApplySummary`:

```typescript
export interface ApplySummary {
  scaffolded: number;
  created: number;
  replaced: number;
  repaired: number;
  generated: number;
  migrated: number;
  errors: string[];
}
```

Initialize `migrated: 0` in `applyPlan`'s `summary`. Add a branch in the `applyPlan` action loop (before the final `else` that handles `generate`) — restructure the `if/else` so `migrate` is explicit:

```typescript
      } else if (action.kind === "migrate") {
        if (!dryRun) {
          const fromAbs = path.resolve(detection.root, action.fromDir);
          const toAbs = path.resolve(detection.root, action.toDir);
          await fsp.mkdir(toAbs, { recursive: true });
          for (const file of action.files) {
            await fsp.rename(path.join(fromAbs, file), path.join(toAbs, file));
          }
          await fsp.rm(fromAbs, { recursive: true, force: true });
        }
        summary.migrated += 1;
      } else {
        // ...existing generate branch unchanged...
```

Change the outer `else if (action.kind === "symlink")` chain accordingly so the generate branch keeps its current body under a `else if (action.kind === "generate")` guard (TypeScript's discriminated union then narrows correctly for `describeAction`).

- [ ] **Step 6: Extend `describeAction`**

Add before the final `return` in `describeAction`:

```typescript
  if (action.kind === "migrate") {
    return `migrate ${action.fromDir} -> ${action.toDir} (${action.files.length} file${action.files.length === 1 ? "" : "s"})`;
  }
```

- [ ] **Step 7: Run migration tests to verify they pass**

Run: `pnpm build && pnpm vitest run test/planner.test.ts`
Expected: PASS — all migration tests plus unchanged existing tests.

- [ ] **Step 8: Surface migration in the setup summary**

In `src/ui/summary.ts`, in `summarizePlan`'s action loop add a `migrate` branch (collect into a new `migrations: string[]` on `PlanSummary`), and in `renderSetupSummary` print a block like:

```typescript
  for (const m of s.migrations) {
    if (lines.length > 0) lines.push("");
    lines.push(`${pc.magenta("migrate")}: ${m}`);
  }
```

with the message: `` `${action.fromDir} -> ${action.toDir}: Cline rules moved; .clinerules is deprecated` ``. Add `migrations: []` to the `PlanSummary` initializer. Keep it minimal — one line per migration.

- [ ] **Step 9: Run full planner + summary suite**

Run: `pnpm build && pnpm vitest run test/planner.test.ts test/summary.test.ts` (run whichever summary test file exists; if none, skip)
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/engine/planner.ts src/ui/summary.ts test/planner.test.ts
git commit -m "feat: migrate legacy .clinerules to .cline/rules with git safety"
```

---

### Task 5: Update documentation

Hand-edit prose; regenerate only the `PRESETS`-derived detection-matrix region.

**Files:**
- Modify: `README.md` (intro para, supported-tools table, wiring table, layout tree, `.clinerules` refs)
- Modify: `docs/features.md` (rules row, preset table row for Cline, instructions note; detection-matrix region regenerated)
- Modify: `docs/architectures.md` (two-mechanism description + migration note)
- Test: `test/docs.test.ts` (must stay green — it verifies the detection-matrix region against `renderDetectionMatrix`)

**Interfaces:** none (docs only).

- [ ] **Step 1: Regenerate the detection-matrix region in `docs/features.md`**

Run: `pnpm build && pnpm vitest run test/docs.test.ts`
Expected: FAIL — matrix stale (Cline path changed to `.cline/rules`). The failure message prints the exact block to paste. Replace the region between `<!-- BEGIN GENERATED: detection-matrix … -->` and `<!-- END GENERATED: detection-matrix -->` in `docs/features.md` with the printed block verbatim.

- [ ] **Step 2: Verify the matrix test passes**

Run: `pnpm vitest run test/docs.test.ts`
Expected: PASS.

- [ ] **Step 3: Fix hand-written prose across the three docs**

Replace every `.clinerules` reference with `.cline/rules`. Specifically:

- **README.md line ~5** (intro): keep the "generates format-correct rule adapters … (Claude Code, Cursor, Windsurf, Copilot, Cline)" wording but add: rules dirs sharing a format are symlinked (Claude↔Cline) rather than duplicated.
- **README.md line ~30** (Cline row): `` `.cline/rules/*.md`, `.cline/skills` ``.
- **README.md line ~47** (wiring row): Cline rules → `link` (symlink to canonical when same format) instead of "adapter".
- **README.md lines ~65-66** (Skills/Rules summary): rules "first existing of `.claude/rules` › `.cursor/rules` › `.windsurf/rules` › `.github/instructions` › `.cline/rules`"; note same-format targets are symlinked.
- **README.md line ~85** (layout tree): replace the `.clinerules/review.md   # generated adapter …` line with `.cline/rules -> ../.claude/rules   # symlink (same format as Claude)`.
- **docs/features.md line ~27 and ~59-64**: correct the note — Cline reads `AGENTS.md` natively (like Codex/Cursor/Windsurf), so no instruction file is wired; it is wired for skills (`.cline/skills`) and rules (`.cline/rules`). The `rules-cline` preset row: path `.cline/rules`, mechanism "dir symlink when format matches canonical, else adapter `.md`".
- **docs/architectures.md**: in the rules-mechanism section, add: rules targets whose adapter format matches the canonical are wired as a **relative directory symlink** (via the shared `planDirSymlinkTarget` helper) rather than generated adapters; document the git-gated `.clinerules → .cline/rules` migration action.

- [ ] **Step 4: Grep to confirm no stale `.clinerules` references remain in docs**

Run: `rg -n "\.clinerules" README.md docs/`
Expected: only intentional references (e.g. in `docs/architectures.md`/`features.md` describing the *migration from* `.clinerules`). No references implying it is a current wiring target.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/features.md docs/architectures.md
git commit -m "docs: document .cline/rules, same-format symlinks, and .clinerules migration"
```

---

### Task 6: Full verify + smoke

**Files:** none (validation only).

- [ ] **Step 1: Run the full gate**

Run: `pnpm verify`
Expected: lint → typecheck → test → build all pass. In particular the CLI smoke tests (which exec `dist/cli.js`) pass with the new preset path.

- [ ] **Step 2: Manual end-to-end sanity in a throwaway dir**

```bash
tmp=$(mktemp -d); cd "$tmp"; git init -q
mkdir -p .claude/rules && printf -- '---\npaths:\n  - "src/**"\n---\nbody\n' > .claude/rules/review.md
git add -A && git commit -qm init
node "$OLDPWD/dist/cli.js" sync --yes --agents claude,cline
ls -la .cline/rules   # expect a symlink -> ../.claude/rules
cd "$OLDPWD"
```
Expected: `.cline/rules` is a symlink to `../.claude/rules`; no `.cline/rules/*.md` copies.

- [ ] **Step 3: Verify migration path manually**

```bash
tmp=$(mktemp -d); cd "$tmp"; git init -q
mkdir -p .clinerules && printf 'body\n' > .clinerules/review.md
git add -A && git commit -qm init
node "$OLDPWD/dist/cli.js" sync --yes --agents cline
test -f .cline/rules/review.md && ! test -e .clinerules && echo "MIGRATED OK"
cd "$OLDPWD"
```
Expected: `MIGRATED OK`.

- [ ] **Step 4: Final commit if any fixups were needed**

```bash
git add -A && git commit -m "chore: fixups from verify" || true
```

---

## Self-Review

**Spec coverage:**
- Goal 1 (`.clinerules` → `.cline/rules`) → Task 1. ✓
- Goal 2 (same-format symlink) → Tasks 2 (helper) + 3 (partition). ✓
- Goal 3 (migration, git-gated, both-exist warning) → Task 4. ✓
- Goal 4 (docs incl. AGENTS.md correction) → Task 5. ✓
- Risk "planAliasConcern has no coverage" → Task 2 Step 1 characterization test. ✓
- Risk "verbatim vs normalized" → symlink semantics are inherent to Task 3 (dir symlink), no code needed. ✓

**Placeholder scan:** No TBD/TODO. The one open item is the `makeProject({ git: true })` helper (Task 4 Step 2) — flagged with an explicit instruction to reuse the existing git-gated-test pattern in `test/helpers.ts` and add the option if absent. This is a genuine "check the helper" step, not a placeholder for logic.

**Type consistency:** `planDirSymlinkTarget(detection, target, canonical, concern, plan)` — same signature in Task 2 (definition) and Task 3 (call). `Action` `migrate` variant fields (`fromDir`, `toDir`, `files`) consistent across Task 4 Steps 1, 4, 5, 6. `ApplySummary.migrated` added in Task 4 Step 5 and asserted in Task 4 Step 2 tests. `CLINERULES_LEGACY`/`CLINE_RULES` constants used consistently.
