import fsp from "node:fs/promises";
import path from "node:path";

import type { Detection } from "../detect.js";
import {
  CONCERN_ORDER,
  SCAFFOLD_STUB,
  findPreset,
  presetsByConcern,
  type AdapterFormat,
  type ConcernKind,
} from "../presets.js";
import { relativeLinkTarget, createSymlink, replaceWithSymlink } from "./symlink.js";
import { generateAdapter, parseGeneratedSource, targetFileName } from "./rules.js";

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
    };

export interface Plan {
  actions: Action[];
  noopCount: number;
  warnings: string[];
  blocked: string[];
}

function emptyPlan(): Plan {
  return { actions: [], noopCount: 0, warnings: [], blocked: [] };
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
      if (canonicalId !== null && !filter.has(canonicalId) && !canonicalSelected) {
        enabled = false;
        targetIds = [];
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

async function planAliasConcern(
  detection: Detection,
  choice: ConcernChoice,
  concern: ConcernKind,
  plan: Plan,
): Promise<void> {
  const { root } = detection;
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
    const state = scan.states.get(target.id);

    switch (state?.type) {
      case undefined:
      case "missing": {
        plan.actions.push({
          kind: "symlink",
          op: "create",
          targetPath: target.path,
          canonicalPath: canonical.path,
        });
        break;
      }
      case "broken-symlink": {
        plan.actions.push({
          kind: "symlink",
          op: "repair",
          targetPath: target.path,
          canonicalPath: canonical.path,
          note: `was a broken link -> ${state.linkText ?? "?"}`,
        });
        break;
      }
      case "symlink-file":
      case "symlink-dir": {
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
      }
      case "file":
      case "dir": {
        if (identicalContent(detection, target.path, canonical.path)) {
          plan.actions.push({
            kind: "symlink",
            op: "replace",
            targetPath: target.path,
            canonicalPath: canonical.path,
            note: "content identical to canonical",
          });
        } else if (concern === "instructions") {
          if (!detection.isGitRepo) {
            plan.blocked.push(
              `${target.path}: differs from ${canonical.path} and this project is not a git repo; refusing to replace (content would be lost). Merge manually, then re-run.`,
            );
          } else if (detection.dirtyPaths.has(target.path)) {
            plan.blocked.push(
              `${target.path}: has uncommitted local edits; commit or stash them first.`,
            );
          } else {
            plan.actions.push({
              kind: "symlink",
              op: "replace",
              targetPath: target.path,
              canonicalPath: canonical.path,
              note: "content differs — previous version stays recoverable via git history",
            });
          }
        } else {
          plan.blocked.push(
            `${target.path}: differs from ${canonical.path}; merge content manually, then re-run.`,
          );
        }
        break;
      }
    }
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

export async function plan(detection: Detection, choices: Choices): Promise<Plan> {
  const result = emptyPlan();
  await planAliasConcern(detection, choices.instructions, "instructions", result);
  await planAliasConcern(detection, choices.skills, "skills", result);
  await planAliasConcern(detection, choices.plugins, "plugins", result);
  await planRulesConcern(detection, choices.rules, result);
  return result;
}

export interface ApplySummary {
  scaffolded: number;
  created: number;
  replaced: number;
  repaired: number;
  generated: number;
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
    errors: [],
  };

  for (const action of planResult.actions) {
    try {
      if (action.kind === "scaffold") {
        if (!dryRun) {
          await fsp.writeFile(path.resolve(detection.root, action.path), SCAFFOLD_STUB, { flag: "wx" });
        }
        summary.scaffolded += 1;
      } else if (action.kind === "symlink") {
        if (action.op === "replace") {
          if (!dryRun) await replaceWithSymlink(detection.root, action.canonicalPath, action.targetPath);
          summary.replaced += 1;
        } else {
          if (!dryRun) await createSymlink(detection.root, action.canonicalPath, action.targetPath);
          if (action.op === "create") summary.created += 1;
          else summary.repaired += 1;
        }
      } else {
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
  if (action.kind === "symlink") {
    return `${action.op === "create" ? "link" : action.op}  ${action.targetPath} -> ${relativeLinkTarget(root, action.canonicalPath, action.targetPath)}${
      action.note ? `   (${action.note})` : ""
    }`;
  }
  return `${action.op === "create" ? "generate" : "regenerate"}  ${action.targetPath}${
    action.note ? `   (${action.note})` : ""
  }`;
}
