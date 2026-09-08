import fsp from "node:fs/promises";
import path from "node:path";

import type { Detection } from "../detect.js";
import {
  CONCERN_ORDER,
  SCAFFOLD_STUB,
  findPreset,
  presetsByConcern,
  type AdapterFormat,
  type AgentPreset,
  type ConcernKind,
} from "../presets.js";
import { relativeLinkTarget, createSymlink, replaceWithSymlink } from "./symlink.js";
import { generateAdapter, parseGeneratedSource, targetFileName } from "./rules.js";
import { treeSignature, walkTree } from "../util/fs.js";

export interface ConcernChoice {
  enabled: boolean;
  canonicalId: string | null;
  targetIds: string[];
}

export type Choices = Record<ConcernKind, ConcernChoice>;

export type Action =
  | { kind: "scaffold"; path: string }
  | {
      kind: "symlink";
      op: "create" | "replace" | "repair";
      targetPath: string;
      canonicalPath: string;
      note?: string;
    }
  | {
      kind: "generate";
      op: "create" | "regenerate";
      targetPath: string;
      sourceRelPath: string;
      format: AdapterFormat;
      note?: string;
    }
  | { kind: "migrate"; fromDir: string; toDir: string };

export interface Conflict {
  targetPath: string;
  canonicalPath: string;
  concern: ConcernKind;
  kind: "file" | "dir";
  /** true when the old content is recoverable via git (repo && path not dirty). */
  gitRecoverable: boolean;
}

export interface Plan {
  actions: Action[];
  noopCount: number;
  warnings: string[];
  blocked: string[];
  conflicts: Conflict[];
}

function emptyPlan(): Plan {
  return { actions: [], noopCount: 0, warnings: [], blocked: [], conflicts: [] };
}

export function makeDefaultChoices(
  detection: Detection,
  opts: { all?: boolean; agents?: Set<string> } = {},
): Choices {
  const result = {} as Choices;
  const filter = opts.all ? undefined : opts.agents;
  for (const concern of CONCERN_ORDER) {
    const presets = presetsByConcern(concern);
    const candidates = presets.filter((p) =>
      detection.concerns[concern].sources.includes(p.id),
    );
    let enabled = candidates.length > 0;
    let canonicalId: string | null = candidates[0]?.id ?? null;
    let targetIds = presets.map((p) => p.id).filter((id) => id !== canonicalId);

    if (!enabled && concern === "instructions") {
      enabled = true;
      canonicalId = "codex";
      targetIds = presets.map((p) => p.id).filter((id) => id !== "codex");
    }

    if (filter) {
      targetIds = targetIds.filter((id) => filter.has(id));
      const canonicalSelected =
        (canonicalId !== null && filter.has(canonicalId)) ||
        (concern === "instructions" && canonicalId === "codex" && filter.size > 0);
      // Wire the concern only when at least one target survived the filter. The canonical may be
      // a shared, non-agent preset (e.g. .agents/skills) no token maps to, so target count — not
      // "is the canonical selected" — decides. Instructions scaffold keeps its codex special-case.
      if (targetIds.length === 0 && !(canonicalSelected && concern === "instructions")) {
        enabled = false;
      }
    }

    result[concern] = { enabled, canonicalId, targetIds };
  }
  return result;
}

function linkPointsTo(
  rootAbs: string,
  targetRel: string,
  linkText: string | undefined,
  canonicalRel: string,
): boolean {
  if (!linkText) return false;
  const abs = path.resolve(rootAbs, path.dirname(path.resolve(rootAbs, targetRel)), linkText);
  return abs === path.resolve(rootAbs, canonicalRel);
}

function identicalContent(detection: Detection, aRel: string, bRel: string): boolean {
  const ha = detection.fileHashes.get(aRel);
  const hb = detection.fileHashes.get(bRel);
  if (ha !== undefined || hb !== undefined) {
    return ha !== undefined && hb !== undefined && ha === hb;
  }
  const sa = detection.dirSignatures.get(aRel);
  const sb = detection.dirSignatures.get(bRel);
  return sa !== undefined && sb !== undefined && sa === sb;
}

async function listRuleFiles(absDir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(absDir);
    return entries.filter((f) => /\.(md|mdc)$/.test(f)).sort();
  } catch {
    return [];
  }
}

const RULE_EXT = /\.(mdc|instructions\.md|md)$/;

function stripExt(name: string): string {
  return name.replace(RULE_EXT, "");
}

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

async function planAliasConcern(
  detection: Detection,
  choice: ConcernChoice,
  concern: ConcernKind,
  plan: Plan,
): Promise<void> {
  const canonical = choice.canonicalId ? findPreset(choice.canonicalId) : undefined;
  if (!choice.enabled || !canonical) return;

  const scan = detection.concerns[concern];
  const canonicalState = scan.states.get(canonical.id);
  const canonicalIsReal = canonicalState?.type === "file" || canonicalState?.type === "dir";

  if (!canonicalIsReal) {
    if (concern === "instructions" && canonicalState?.type === "missing") {
      plan.actions.push({ kind: "scaffold", path: canonical.path });
    } else {
      plan.warnings.push(`${concern}: canonical ${canonical.path} is not a regular ${canonical.kind}; skipped.`);
      return;
    }
  }

  for (const targetId of choice.targetIds) {
    if (targetId === canonical.id) continue;
    const target = findPreset(targetId);
    if (!target) continue;
    planDirSymlinkTarget(detection, target, canonical, concern, plan);
  }
}

async function planRulesConcern(
  detection: Detection,
  choice: ConcernChoice,
  plan: Plan,
): Promise<void> {
  if (!choice.enabled || !choice.canonicalId) return;
  const canonical = findPreset(choice.canonicalId);
  if (!canonical || canonical.adapter === undefined) return;

  const scan = detection.concerns.rules;
  const canonicalState = scan.states.get(canonical.id);
  if (canonicalState?.type !== "dir") {
    plan.warnings.push(`rules: canonical ${canonical.path} is not a directory; skipped.`);
    return;
  }

  const canonicalNames = await listRuleFiles(path.resolve(detection.root, canonical.path));
  if (canonicalNames.length === 0) {
    plan.warnings.push(`rules: no .md/.mdc files found in ${canonical.path}; nothing to generate.`);
    return;
  }

  const canonicalBases = new Set(canonicalNames.map(stripExt));

  for (const targetId of choice.targetIds) {
    if (targetId === canonical.id) continue;
    const target = findPreset(targetId);
    if (!target || target.adapter === undefined) continue;

    // Same adapter format as canonical → wire the whole dir as a symlink.
    if (target.adapter === canonical.adapter) {
      const existing =
        scan.states.get(target.id)?.type === "dir"
          ? await listRuleFiles(path.resolve(detection.root, target.path))
          : [];
      const foreign = existing.filter((name) => !canonicalBases.has(stripExt(name)));
      if (foreign.length > 0) {
        plan.blocked.push(
          `${target.path}: contains its own rule files (${foreign.join(", ")}); merge into ${canonical.path}, then re-run.`,
        );
        continue;
      }
      planDirSymlinkTarget(detection, target, canonical, "rules", plan);
      continue;
    }

    // Differing format — generate per-file adapters (unchanged path).
    const state = scan.states.get(target.id);

    if (state?.type === "symlink-file" || state?.type === "symlink-dir") {
      if (linkPointsTo(detection.root, target.path, state.linkText, canonical.path)) {
        plan.noopCount += 1;
        plan.warnings.push(
          `${target.path} already links to ${canonical.path}; adapter generation skipped.`,
        );
      } else {
        plan.warnings.push(`${target.path} is a symlink elsewhere (${state.linkText ?? "?"}); left untouched.`);
      }
      continue;
    }

    const existing =
      state?.type === "dir"
        ? await listRuleFiles(path.resolve(detection.root, target.path))
        : [];

    const foreign = existing.filter((name) => !canonicalBases.has(stripExt(name)));
    if (foreign.length > 0) {
      plan.blocked.push(
        `${target.path}: contains its own rule files (${foreign.join(", ")}); merge into ${canonical.path}, then re-run.`,
      );
      continue;
    }

    for (const name of canonicalNames) {
      const outRel = `${target.path}/${targetFileName(name, target.adapter)}`;
      const srcRel = `${canonical.path}/${name}`;
      await compareGenerated(detection, outRel, srcRel, target.adapter, plan);
    }

    for (const g of detection.generatedFiles) {
      if (g.dirPresetId !== target.id) continue;
      const base = path.posix.basename(g.sourceRelPath).replace(RULE_EXT, "");
      if (!canonicalBases.has(base) || !g.sourceRelPath.startsWith(canonical.path)) {
        plan.warnings.push(
          `${target.path}/${g.fileName}: was generated from "${g.sourceRelPath}" which is not part of the canonical set; remove it manually if obsolete.`,
        );
      }
    }
  }
}

async function compareGenerated(
  detection: Detection,
  outRel: string,
  srcRel: string,
  format: AdapterFormat,
  plan: Plan,
): Promise<void> {
  const srcContent = await fsp
    .readFile(path.resolve(detection.root, srcRel), "utf8")
    .catch(() => null);
  if (srcContent === null) return;
  const expected = generateAdapter({ sourceRelPath: srcRel, sourceContent: srcContent, format });
  const current = await fsp.readFile(path.resolve(detection.root, outRel), "utf8").catch(() => null);

  if (current === null) {
    plan.actions.push({ kind: "generate", op: "create", targetPath: outRel, sourceRelPath: srcRel, format });
  } else if (current === expected) {
    plan.noopCount += 1;
  } else if (parseGeneratedSource(current) === null) {
    plan.blocked.push(
      `${outRel}: an authored file (no agents-aliases marker) occupies this adapter's output name; rename it or merge it into ${srcRel}, then re-run.`,
    );
  } else {
    plan.actions.push({
      kind: "generate",
      op: "regenerate",
      targetPath: outRel,
      sourceRelPath: srcRel,
      format,
      note: "drifted from source",
    });
  }
}

const CLINERULES_LEGACY = ".clinerules";
const CLINERULES_NEW = ".cline/rules";
const CLINERULES_NEW_PRESET = "rules-cline";

export async function planClinerulesMigration(detection: Detection, plan: Plan): Promise<void> {
  const legacyAbs = path.resolve(detection.root, CLINERULES_LEGACY);
  let legacyExists = false;
  try {
    const stat = await fsp.stat(legacyAbs);
    legacyExists = stat.isDirectory();
  } catch {
    // not present
  }
  if (!legacyExists) return;

  const newAbs = path.resolve(detection.root, CLINERULES_NEW);
  let newExists = false;
  try {
    const stat = await fsp.stat(newAbs);
    newExists = stat.isDirectory();
  } catch {
    // not present
  }

  if (newExists) {
    plan.warnings.push(
      `.clinerules is deprecated — ${CLINERULES_NEW} already exists. Merge .clinerules manually, then remove it.`,
    );
    return;
  }

  if (!detection.isGitRepo) {
    plan.blocked.push(
      `.clinerules: cannot migrate to ${CLINERULES_NEW} outside a git repo (no safety net). Init a git repo and re-run.`,
    );
    return;
  }

  // Also block if any path under .clinerules is dirty.
  const dirty = [...detection.dirtyPaths].some((p) => p.startsWith(`${CLINERULES_LEGACY}/`));
  if (dirty) {
    plan.blocked.push(
      `.clinerules: cannot migrate to ${CLINERULES_NEW} — directory has uncommitted changes. Commit or stash, then re-run.`,
    );
    return;
  }

  plan.actions.push({ kind: "migrate", fromDir: CLINERULES_LEGACY, toDir: CLINERULES_NEW });

  // Mutate the in-memory detection so downstream rules planning sees the *post-migration*
  // reality: `.cline/rules` will exist as a real dir holding the old `.clinerules` content.
  // Without this, planRulesConcern reads the pre-migration snapshot (`.cline/rules` missing) and
  // emits a symlink `create` for a path that applyPlan's rename has since populated → EEXIST.
  detection.concerns.rules.states.set(CLINERULES_NEW_PRESET, {
    presetId: CLINERULES_NEW_PRESET,
    relPath: CLINERULES_NEW,
    type: "dir",
  });

  // Pick the rules canonical the same way makeDefaultChoices does: the first existing rules
  // source, in preset order, that is not Cline itself.
  const canonicalRulesPreset = presetsByConcern("rules").find(
    (p) => p.id !== CLINERULES_NEW_PRESET && detection.concerns.rules.sources.includes(p.id),
  );

  if (canonicalRulesPreset) {
    // A same-format symlink TARGET exists and the user chose it as canonical. The migrated
    // `.cline/rules` is a git-recoverable, deprecated-location dir — so it must be wired via
    // `replace` REGARDLESS of content difference (the "protect differing content → conflict"
    // rule guards a normal pre-existing dir, not a just-migrated one whose old bytes stay in git).
    // Forcing `.cline/rules`'s signature to equal the canonical's makes identicalContent() true →
    // planDirSymlinkTarget emits `replace`.
    const canonicalAbs = path.resolve(detection.root, canonicalRulesPreset.path);
    const canonicalSignature =
      detection.dirSignatures.get(canonicalRulesPreset.path) ??
      treeSignature(await walkTree(canonicalAbs));
    detection.dirSignatures.set(canonicalRulesPreset.path, canonicalSignature);
    detection.dirSignatures.set(CLINERULES_NEW, canonicalSignature);
  } else {
    // Cline is itself the rules canonical (no other rules dir) — no symlink target to wire.
    // Keep the migrated dir as-is; its real content is what downstream planning should see.
    detection.dirSignatures.set(CLINERULES_NEW, treeSignature(await walkTree(legacyAbs)));
  }
}

export async function plan(detection: Detection, choices: Choices): Promise<Plan> {
  const result = emptyPlan();
  await planClinerulesMigration(detection, result);
  await planAliasConcern(detection, choices.instructions, "instructions", result);
  await planAliasConcern(detection, choices.skills, "skills", result);
  await planAliasConcern(detection, choices.plugins, "plugins", result);
  await planRulesConcern(detection, choices.rules, result);
  return result;
}

/**
 * Resolve conflicts for a non-interactive run (`--yes`/CI): overwrite only where the old content
 * is recoverable from git, and only for instructions (matching the historical safe default).
 * Everything else stays an unresolved conflict, so `--yes` never silently destroys content.
 * Mutates `plan`: converts resolved conflicts into `replace` actions; leaves the rest in `conflicts`.
 */
export function resolveConflictsNonInteractive(plan: Plan): void {
  const unresolved: Conflict[] = [];
  for (const c of plan.conflicts) {
    if (c.concern === "instructions" && c.gitRecoverable) {
      plan.actions.push({
        kind: "symlink",
        op: "replace",
        targetPath: c.targetPath,
        canonicalPath: c.canonicalPath,
        note: "content differs — previous version stays recoverable via git history",
      });
    } else {
      unresolved.push(c);
    }
  }
  plan.conflicts = unresolved;
}

/**
 * Convert a user-accepted "overwrite" conflict into a `replace` action (interactive path).
 * Mutates `plan`: appends the action and removes the conflict from `plan.conflicts`.
 */
export function overwriteConflict(plan: Plan, conflict: Conflict): void {
  plan.actions.push({
    kind: "symlink",
    op: "replace",
    targetPath: conflict.targetPath,
    canonicalPath: conflict.canonicalPath,
    note: conflict.gitRecoverable
      ? "content differs — previous version stays recoverable via git history"
      : "content differs — overwritten at your request (no git safety net)",
  });
  plan.conflicts = plan.conflicts.filter((c) => c.targetPath !== conflict.targetPath);
}

export interface ApplySummary {
  scaffolded: number;
  created: number;
  replaced: number;
  repaired: number;
  generated: number;
  migrated: number;
  errors: string[];
}

export async function applyPlan(
  detection: Detection,
  planResult: Plan,
  dryRun: boolean,
): Promise<ApplySummary> {
  const summary: ApplySummary = {
    scaffolded: 0,
    created: 0,
    replaced: 0,
    repaired: 0,
    generated: 0,
    migrated: 0,
    errors: [],
  };

  for (const action of planResult.actions) {
    try {
      if (action.kind === "scaffold") {
        if (!dryRun) {
          await fsp.writeFile(path.resolve(detection.root, action.path), SCAFFOLD_STUB, { flag: "wx" });
        }
        summary.scaffolded += 1;
      } else if (action.kind === "migrate") {
        if (!dryRun) {
          const fromAbs = path.resolve(detection.root, action.fromDir);
          const toAbs = path.resolve(detection.root, action.toDir);
          await fsp.mkdir(path.dirname(toAbs), { recursive: true });
          await fsp.rename(fromAbs, toAbs);
        }
        summary.migrated += 1;
      } else if (action.kind === "symlink") {
        if (action.op === "replace") {
          if (!dryRun) await replaceWithSymlink(detection.root, action.canonicalPath, action.targetPath);
          summary.replaced += 1;
        } else {
          if (!dryRun) await createSymlink(detection.root, action.canonicalPath, action.targetPath);
          if (action.op === "create") summary.created += 1;
          else summary.repaired += 1;
        }
      } else if (action.kind === "generate") {
        if (!dryRun) {
          await fsp.mkdir(path.dirname(path.resolve(detection.root, action.targetPath)), {
            recursive: true,
          });
          const src = await fsp.readFile(path.resolve(detection.root, action.sourceRelPath), "utf8");
          await fsp.writeFile(
            path.resolve(detection.root, action.targetPath),
            generateAdapter({
              sourceRelPath: action.sourceRelPath,
              sourceContent: src,
              format: action.format,
            }),
          );
        }
        summary.generated += 1;
      }
    } catch (err) {
      summary.errors.push(`${describeAction(action, detection.root)}: ${(err as Error).message}`);
    }
  }
  return summary;
}

export function describeAction(action: Action, root: string): string {
  if (action.kind === "scaffold") return `scaffold ${action.path}`;
  if (action.kind === "migrate") return `migrate  ${action.fromDir} -> ${action.toDir}`;
  if (action.kind === "symlink") {
    return `${action.op === "create" ? "link" : action.op}  ${action.targetPath} -> ${relativeLinkTarget(root, action.canonicalPath, action.targetPath)}${
      action.note ? `   (${action.note})` : ""
    }`;
  }
  return `${action.op === "create" ? "generate" : "regenerate"}  ${action.targetPath}${
    action.note ? `   (${action.note})` : ""
  }`;
}
