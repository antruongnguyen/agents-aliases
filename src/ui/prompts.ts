import * as p from "@clack/prompts";

import { describeState, type Detection } from "../detect.js";
import {
  CONCERN_LABELS,
  CONCERN_ORDER,
  PRESETS,
  presetsByConcern,
  type ConcernKind,
} from "../presets.js";
import type { Choices } from "../engine/planner.js";

export function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY && !process.env.CI);
}

function checkCancel(value: unknown): void {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
}

async function pickCanonical(
  detection: Detection,
  concern: ConcernKind,
): Promise<string | null> {
  const candidates = presetsByConcern(concern).filter((preset) =>
    detection.concerns[concern].sources.includes(preset.id),
  );
  if (candidates.length <= 1) return candidates[0]?.id ?? null;

  const options = candidates.map((preset) => {
    const first = candidates[0];
    const sameAsFirst = first !== undefined && preset.id !== first.id;
    return {
      value: preset.id,
      label: `${preset.tool} (${preset.path})`,
      hint:
        sameAsFirst && first && signaturesMatch(detection, concern, first.id, preset.id)
          ? "content identical to other copies"
          : "has unique content",
    };
  });

  const selected = await p.select({
    message: `Multiple ${CONCERN_LABELS[concern].toLowerCase()} sources found — keep which one as the canonical?`,
    options,
    initialValue: candidates[0]?.id,
  });
  checkCancel(selected);
  return (selected as string) ?? null;
}

function signaturesMatch(detection: Detection, concern: ConcernKind, a: string, b: string): boolean {
  const pa = findPath(a);
  const pb = findPath(b);
  if (!pa || !pb) return false;
  const ha = detection.fileHashes.get(pa) ?? detection.dirSignatures.get(pa);
  const hb = detection.fileHashes.get(pb) ?? detection.dirSignatures.get(pb);
  return ha !== undefined && ha === hb;
}

function findPath(presetId: string): string | undefined {
  return PRESETS.find((x) => x.id === presetId)?.path;
}

async function pickTargets(
  detection: Detection,
  concern: ConcernKind,
  canonicalId: string | null,
): Promise<string[]> {
  const options = presetsByConcern(concern)
    .filter((preset) => preset.id !== canonicalId)
    .map((preset) => {
      const state = detection.concerns[concern].states.get(preset.id);
      let hint = describeState(state);
      if (hint === "exists") hint = "exists (will be replaced by alias)";
      else if (hint.startsWith("linked")) hint = "already linked";
      return { value: preset.id, label: `${preset.tool}`, hint: `${preset.path} · ${hint}` };
    });

  const selected = await p.multiselect({
    message: "Target agents? (enter accepts everything)",
    options,
    initialValues: options.map((o) => o.value),
    required: false,
  });
  checkCancel(selected);
  const values = (selected as string[]) ?? [];
  return values.length === 0 ? options.map((o) => o.value as string) : values;
}

export async function runWizard(detection: Detection): Promise<Choices | null> {
  p.intro("agents-aliases — one source of truth for every coding agent");

  const scanLines: string[] = [];
  for (const concern of CONCERN_ORDER) {
    const scan = detection.concerns[concern];
    const entries = [...scan.states.values()];
    if (entries.every((s) => s.type === "missing")) continue;
    scanLines.push(`${CONCERN_LABELS[concern]}:`);
    for (const s of entries) {
      const icon =
        s.type === "broken-symlink" ? "!" : s.type === "missing" ? "-" : "+";
      scanLines.push(`  ${icon} ${s.relPath.padEnd(34)} ${describeState(s)}`);
    }
  }
  p.log.message(scanLines.join("\n"));

  const choices = {} as Choices;
  for (const concern of CONCERN_ORDER) {
    choices[concern] = { enabled: false, canonicalId: null, targetIds: [] };
  }

  for (const concern of CONCERN_ORDER) {
    const scan = detection.concerns[concern];
    const hasAnything = [...scan.states.values()].some((s) => s.type !== "missing");

    if (!hasAnything) continue;

    const confirm = await p.confirm({
      message: `Set up aliases for ${CONCERN_LABELS[concern].toLowerCase()}?`,
      initialValue: true,
    });
    checkCancel(confirm);
    if (!confirm) {
      choices[concern] = { enabled: false, canonicalId: null, targetIds: [] };
      continue;
    }

    const canonicalId = await pickCanonical(detection, concern);
    if (canonicalId === null) {
      choices[concern] = { enabled: false, canonicalId: null, targetIds: [] };
      continue;
    }

    const targetIds = await pickTargets(detection, concern, canonicalId);
    choices[concern] = { enabled: true, canonicalId, targetIds };
  }

  const instructionsScan = detection.concerns.instructions;
  if ([...instructionsScan.states.values()].every((s) => s.type === "missing")) {
    const scaffold = await p.confirm({
      message: "No instruction file found. Create AGENTS.md and wire all agents to it?",
      initialValue: true,
    });
    checkCancel(scaffold);
    choices.instructions = scaffold
      ? {
          enabled: true,
          canonicalId: "codex",
          targetIds: presetsByConcern("instructions")
            .map((x) => x.id)
            .filter((id) => id !== "codex"),
        }
      : { enabled: false, canonicalId: null, targetIds: [] };
  }

  p.outro("Plan ready.");
  return choices;
}
