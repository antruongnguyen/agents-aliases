import { detect } from "../detect.js";
import { CONCERN_LABELS, CONCERN_ORDER, findPreset } from "../presets.js";

export async function runStatus(): Promise<number> {
  const detection = await detect(process.cwd());
  const lines: string[] = [];

  for (const concern of CONCERN_ORDER) {
    const scan = detection.concerns[concern];
    const states = [...scan.states.values()];
    if (states.every((s) => s.type === "missing")) continue;
    lines.push(`${CONCERN_LABELS[concern]}`);
    for (const state of states) {
      if (state.type === "missing") continue;
      const preset = findPreset(state.presetId)!;
      let detail: string;
      switch (state.type) {
        case "file":
        case "dir":
          detail =
            preset.adapter !== undefined && scan.sources.length > 1
              ? "adapter target (generated)"
              : "canonical candidate (real file)";
          break;
        case "symlink-file":
        case "symlink-dir":
          detail = `alias -> ${state.linkText}`;
          break;
        case "broken-symlink":
          detail = `BROKEN alias -> ${state.linkText} (run: agents-aliases sync)`;
          break;
      }
      lines.push(`  ${state.relPath.padEnd(36)} ${detail}${preset.adapter ? ` [${preset.tool}]` : ""}`);
    }
    for (const gen of detection.generatedFiles.filter((g) =>
      states.some((s) => s.presetId === g.dirPresetId),
    )) {
      lines.push(`    generated: ${gen.fileName} (from ${gen.sourceRelPath})`);
    }
  }

  console.log(lines.length > 0 ? lines.join("\n") : "No agent configuration detected in this project.");
  return 0;
}
