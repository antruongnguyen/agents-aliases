import fsp from "node:fs/promises";
import path from "node:path";

import { detect } from "../detect.js";
import {
  generateAdapter,
  parseGeneratedSource,
  stripRuleExtension,
} from "../engine/rules.js";
import { PRESETS, findPreset, presetsByConcern } from "../presets.js";

interface CheckFailure {
  path: string;
  reason: string;
}

export async function runCheck(): Promise<number> {
  const root = process.cwd();
  const detection = await detect(root);
  const failures: CheckFailure[] = [];

  for (const preset of PRESETS) {
    const state = detection.concerns[preset.concern].states.get(preset.id);
    if (state?.type === "broken-symlink") {
      failures.push({
        path: preset.path,
        reason: `alias is broken -> ${state.linkText}`,
      });
    }
    if (
      preset.adapter === undefined &&
      (state?.type === "file" || state?.type === "dir") &&
      detection.concerns[preset.concern].sources.length > 1
    ) {
      failures.push({
        path: preset.path,
        reason: "duplicate real file where an alias was expected — content may drift",
      });
    }
  }

  for (const gen of detection.generatedFiles) {
    const dirPreset = PRESETS.find((x) => x.id === gen.dirPresetId);
    if (!dirPreset?.adapter) continue;
    const absOut = path.resolve(root, dirPreset.path, gen.fileName);
    const srcAbs = path.resolve(root, gen.sourceRelPath);
    const srcContent = await fsp.readFile(srcAbs, "utf8").catch(() => null);
    if (srcContent === null) {
      failures.push({
        path: `${dirPreset.path}/${gen.fileName}`,
        reason: `generated from missing source ${gen.sourceRelPath}`,
      });
      continue;
    }
    const expected = generateAdapter({
      sourceRelPath: gen.sourceRelPath,
      sourceContent: srcContent,
      format: dirPreset.adapter,
    });
    const current = await fsp.readFile(absOut, "utf8");
    if (parseGeneratedSource(current) === null) {
      failures.push({ path: `${dirPreset.path}/${gen.fileName}`, reason: "generated marker missing" });
      continue;
    }
    if (current !== expected) {
      failures.push({
        path: `${dirPreset.path}/${gen.fileName}`,
        reason: `drifted from ${gen.sourceRelPath} (run: agents-aliases sync)`,
      });
    }
  }

  const rulesScan = detection.concerns.rules;
  const canonicalRulesId = presetsByConcern("rules").find((p) =>
    rulesScan.sources.includes(p.id),
  )?.id;
  if (canonicalRulesId !== undefined) {
    const canonicalPath = findPreset(canonicalRulesId)!.path;
    const canonicalBases = new Set(
      (await listRuleFiles(path.resolve(root, canonicalPath))).map(stripRuleExtension),
    );
    for (const p of presetsByConcern("rules")) {
      if (p.id === canonicalRulesId || p.adapter === undefined) continue;
      const st = rulesScan.states.get(p.id);
      if (st?.type !== "dir") continue;
      const dirAbs = path.resolve(root, p.path);
      for (const f of await listRuleFiles(dirAbs)) {
        if (!canonicalBases.has(stripRuleExtension(f))) continue;
        const content = await fsp.readFile(path.join(dirAbs, f), "utf8");
        if (parseGeneratedSource(content) === null) {
          failures.push({
            path: `${p.path}/${f}`,
            reason: `authored file shadows adapter output from ${canonicalPath} (run: agents-aliases after renaming or merging)`,
          });
        }
      }
    }
  }

  if (failures.length === 0) {
    console.log("check: all agent aliases are wired correctly.");
    return 0;
  }
  console.error(`check: ${failures.length} problem(s) found:`);
  for (const f of failures) console.error(`  x ${f.path}: ${f.reason}`);
  return 1;
}

async function listRuleFiles(absDir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(absDir);
    return entries.filter((f) => /\.(md|mdc)$/.test(f)).sort();
  } catch {
    return [];
  }
}
