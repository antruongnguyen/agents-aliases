import pc from "picocolors";

import { presetsByConcern, PRESETS, CONCERN_ORDER, type ConcernKind } from "../presets.js";
import type { Plan } from "../engine/planner.js";

export interface CanonicalGroup {
  concern: ConcernKind;
  canonicalPath: string;
  creates: string[];
  replaces: string[];
  repairs: string[];
}

export interface GeneratedGroup {
  targetDir: string;
  files: string[];
}

export interface PlanSummary {
  scaffolds: string[];
  canonicalGroups: CanonicalGroup[];
  generatedGroups: GeneratedGroup[];
  migrations: string[];
  warnings: string[];
  blocked: string[];
  conflicts: string[];
  noopCount: number;
}

function concernForPath(relPath: string): ConcernKind | null {
  for (const concern of CONCERN_ORDER) {
    for (const preset of presetsByConcern(concern)) {
      if (relPath === preset.path || relPath.startsWith(`${preset.path}/`)) return concern;
    }
  }
  return null;
}

/** Human label for a target path: tool name when it belongs to a known preset dir. */
function targetLabel(targetPath: string): string {
  const owner = PRESETS.find((p) => targetPath === p.path || targetPath.startsWith(`${p.path}/`));
  return owner ? `${owner.tool} (${targetPath})` : targetPath;
}

/** Pure grouping of plan actions into overview data. */
export function summarizePlan(planResult: Plan): PlanSummary {
  const summary: PlanSummary = {
    scaffolds: [],
    canonicalGroups: [],
    generatedGroups: [],
    migrations: [],
    warnings: [...planResult.warnings],
    blocked: [...planResult.blocked],
    conflicts: planResult.conflicts.map(
      (c) => `${c.targetPath} differs from ${c.canonicalPath}${c.gitRecoverable ? "" : " (no git safety net)"}`,
    ),
    noopCount: planResult.noopCount,
  };

  const byCanonical = new Map<string, CanonicalGroup>();

  for (const action of planResult.actions) {
    if (action.kind === "scaffold") {
      summary.scaffolds.push(action.path);
      continue;
    }

    if (action.kind === "migrate") {
      summary.migrations.push(`${action.fromDir} -> ${action.toDir}`);
      continue;
    }

    if (action.kind === "generate") {
      const dir = action.targetPath.split("/").slice(0, -1).join("/");
      let group = summary.generatedGroups.find((g) => g.targetDir === dir);
      if (!group) {
        group = { targetDir: dir, files: [] };
        summary.generatedGroups.push(group);
      }
      group.files.push(action.targetPath.split("/").at(-1)!);
      continue;
    }

    let group = byCanonical.get(action.canonicalPath);
    if (!group) {
      group = {
        concern: concernForPath(action.canonicalPath) ?? "instructions",
        canonicalPath: action.canonicalPath,
        creates: [],
        replaces: [],
        repairs: [],
      };
      byCanonical.set(action.canonicalPath, group);
    }
    if (action.op === "create") group.creates.push(action.targetPath);
    else if (action.op === "replace") group.replaces.push(action.targetPath);
    else group.repairs.push(action.targetPath);
  }

  summary.canonicalGroups = CONCERN_ORDER.flatMap((concern) =>
    [...byCanonical.values()].filter((g) => g.concern === concern),
  );
  return summary;
}

function formatPaths(paths: string[]): string {
  return paths.map((p) => targetLabel(p)).join(pc.dim(", "));
}

/**
 * Render a skills-style "Setup Summary": one block per canonical source with
 * its affected targets, plus scaffold/generate blocks and warnings.
 */
export function renderSetupSummary(planResult: Plan): string {
  const s = summarizePlan(planResult);
  const lines: string[] = [];

  for (const path of s.scaffolds) {
    lines.push(`${pc.green("+")} ${pc.cyan(path)} ${pc.dim("(new)")}`);
  }

  for (const [i, group] of s.canonicalGroups.entries()) {
    if (lines.length > 0 && !(s.scaffolds.length > 0 && i === 0)) lines.push("");
    lines.push(pc.cyan(group.canonicalPath));
    if (group.creates.length > 0)
      lines.push(`  ${pc.green("link")}:     ${formatPaths(group.creates)}`);
    if (group.repairs.length > 0)
      lines.push(`  ${pc.yellow("repair")}:   ${formatPaths(group.repairs)}`);
    if (group.replaces.length > 0)
      lines.push(`  ${pc.yellow("replace")}:  ${formatPaths(group.replaces)}`);
  }

  for (const group of s.generatedGroups) {
    if (lines.length > 0) lines.push("");
    lines.push(pc.cyan(group.targetDir));
    lines.push(`  ${pc.blue("generate")}: ${group.files.join(pc.dim(", "))}`);
  }

  if (s.migrations.length > 0) {
    if (lines.length > 0) lines.push("");
    for (const m of s.migrations) {
      lines.push(`  ${pc.green("migrate")}: ${m}`);
    }
  }

  if (s.noopCount > 0) {
    lines.push("");
    lines.push(pc.dim(`already up to date: ${s.noopCount}`));
  }
  for (const w of s.warnings) lines.push(`  ${pc.yellow(`! ${w}`)}`);
  for (const c of s.conflicts) lines.push(`  ${pc.yellow(`? skipped: ${c}`)}`);
  for (const b of s.blocked) lines.push(`  ${pc.red(`x ${b}`)}`);

  return lines.join("\n");
}
