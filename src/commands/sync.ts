import fsp from "node:fs/promises";
import path from "node:path";

import { detect } from "../detect.js";
import { PRESETS, findPreset, presetsByConcern } from "../presets.js";
import { generateAdapter } from "../engine/rules.js";
import { createSymlink } from "../engine/symlink.js";

interface SyncReport {
  repairedLinks: number;
  regeneratedFiles: number;
  unfixable: string[];
  warnings: string[];
}

export async function runSync(dryRun: boolean): Promise<number> {
  const root = process.cwd();
  const detection = await detect(root);
  const report: SyncReport = {
    repairedLinks: 0,
    regeneratedFiles: 0,
    unfixable: [],
    warnings: [],
  };

  for (const preset of PRESETS) {
    const state = detection.concerns[preset.concern].states.get(preset.id);

    if (state?.type === "broken-symlink") {
      const concernPresets = presetsByConcern(preset.concern);
      const canonicalId = concernPresets.find((c) =>
        detection.concerns[preset.concern].sources.includes(c.id),
      )?.id;
      const canRelink =
        preset.adapter === undefined &&
        canonicalId !== undefined &&
        canonicalId !== preset.id;

      if (canRelink) {
        const canonical = findPreset(canonicalId)!;
        try {
          if (!dryRun) await createSymlink(root, canonical.path, preset.path);
          report.repairedLinks += 1;
          continue;
        } catch {
          report.unfixable.push(
            `${preset.path}: failed to relink to ${canonical.path}.`,
          );
          continue;
        }
      }

      report.unfixable.push(
        `${preset.path} is a broken link -> ${state.linkText}; no canonical to relink to. Run \`agents-aliases\` to re-wire.`,
      );
    }

    if (
      preset.adapter === undefined &&
      (state?.type === "file" || state?.type === "dir") &&
      detection.concerns[preset.concern].sources.length > 1
    ) {
      report.warnings.push(
        `${preset.path} is a real file while other copies exist in this concern — possible drift; re-run \`agents-aliases\` to re-wire.`,
      );
    }
  }

  for (const gen of detection.generatedFiles) {
    const dirPreset = PRESETS.find((x) => x.id === gen.dirPresetId);
    if (!dirPreset?.adapter) continue;
    const absOut = path.resolve(root, dirPreset.path, gen.fileName);
    const absSrc = path.resolve(root, gen.sourceRelPath);
    const srcContent = await fsp.readFile(absSrc, "utf8").catch(() => null);
    if (srcContent === null) {
      report.unfixable.push(
        `${path.join(dirPreset.path, gen.fileName)} was generated from missing source ${gen.sourceRelPath}.`,
      );
      continue;
    }
    const expected = generateAdapter({
      sourceRelPath: gen.sourceRelPath,
      sourceContent: srcContent,
      format: dirPreset.adapter,
    });
    const current = await fsp.readFile(absOut, "utf8").catch(() => null);
    if (current !== null && current !== expected) {
      if (!dryRun) await fsp.writeFile(absOut, expected);
      report.regeneratedFiles += 1;
    }
  }

  console.log(`sync: ${report.repairedLinks} link(s) repaired, ${report.regeneratedFiles} generated file(s) refreshed.`);
  for (const w of report.warnings) console.log(`warn: ${w}`);
  for (const u of report.unfixable) console.log(`error: ${u}`);
  return report.unfixable.length > 0 ? 1 : 0;
}
