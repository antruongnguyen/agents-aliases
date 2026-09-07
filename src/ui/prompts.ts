import * as p from "@clack/prompts";
import pc from "picocolors";

import { describeState, type Detection } from "../detect.js";
import {
  AGENT_PICKER,
  CONCERN_LABELS,
  CONCERN_ORDER,
  PRESETS,
  expandAgentList,
  presetsByConcern,
  type ConcernKind,
} from "../presets.js";
import { makeDefaultChoices, type Choices } from "../engine/planner.js";
import { cancelSymbol, searchMultiselect } from "./search-multiselect.js";

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

/** One up-front multiselect of agents; empty submit = all (matches "enter = everything"). */
async function pickAgents(): Promise<Set<string>> {
  const items = AGENT_PICKER.map((a) => ({ value: a.token, label: a.label }));
  const selected = await searchMultiselect({
    message: "Which agents should share your configuration?",
    items,
    initialSelected: items.map((o) => o.value),
    selectAll: true,
    itemNoun: "agents",
  });
  if (selected === cancelSymbol || p.isCancel(selected)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
  const tokens = selected as string[];
  return expandAgentList(tokens.join(","));
}

export async function runWizard(detection: Detection): Promise<Choices | null> {
  p.intro(pc.bgCyan(pc.black(" agents-aliases ")));

  const scanLines: string[] = [];
  for (const concern of CONCERN_ORDER) {
    const scan = detection.concerns[concern];
    const entries = [...scan.states.values()];
    if (entries.every((s) => s.type === "missing")) continue;
    scanLines.push(`${pc.bold(CONCERN_LABELS[concern])}:`);
    for (const s of entries) {
      const icon =
        s.type === "broken-symlink"
          ? pc.red("!")
          : s.type === "missing"
            ? pc.dim("-")
            : pc.green("+");
      scanLines.push(`  ${icon} ${s.relPath.padEnd(34)} ${describeState(s)}`);
    }
  }
  if (scanLines.length > 0) p.log.message(scanLines.join("\n"));

  const agents = await pickAgents();
  const choices = makeDefaultChoices(detection, { agents });

  // Per-concern canonical override when the user has ≥2 real sources to choose from.
  for (const concern of CONCERN_ORDER) {
    if (!choices[concern].enabled) continue;
    const canonicalId = await pickCanonical(detection, concern);
    if (canonicalId && canonicalId !== choices[concern].canonicalId) {
      const targetIds = choices[concern].targetIds
        .filter((id) => id !== canonicalId)
        .concat(choices[concern].canonicalId ? [choices[concern].canonicalId] : [])
        .filter((id) => agents.has(id));
      choices[concern] = { enabled: true, canonicalId, targetIds };
    }
  }

  p.outro(pc.dim("Review the plan to confirm."));
  return choices;
}
