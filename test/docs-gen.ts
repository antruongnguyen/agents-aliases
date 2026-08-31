import { PRESETS, CONCERN_ORDER, type AgentPreset } from "../src/presets.js";
import { targetFileName } from "../src/engine/rules.js";

/** Wiring column: derived purely from a preset's kind + adapter. */
function wiring(preset: AgentPreset): string {
  if (preset.adapter) {
    const ext = targetFileName("x.md", preset.adapter).replace(/^x/, "");
    return `adapter \`${ext}\``;
  }
  return preset.kind === "dir" ? "dir symlink" : "symlink";
}

/**
 * The detection-matrix table in docs/features.md is generated from PRESETS so it
 * cannot drift. Regenerate the marked region with this and paste it in.
 */
export function renderDetectionMatrix(): string {
  const rows = CONCERN_ORDER.flatMap((concern) =>
    PRESETS.filter((p) => p.concern === concern).map(
      (p) => `| ${concern} | \`${p.id}\` | \`${p.path}\` | ${p.tool} | ${wiring(p)} |`,
    ),
  );
  return [
    "| Concern | Preset id | Path | Tool | Wiring |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

export const MATRIX_BEGIN =
  "<!-- BEGIN GENERATED: detection-matrix (derived from PRESETS; verified by test/docs.test.ts — paste the block it prints on failure) -->";
export const MATRIX_END = "<!-- END GENERATED: detection-matrix -->";
