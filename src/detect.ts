import fsp from "node:fs/promises";
import path from "node:path";

import { PRESETS, type ConcernKind } from "./presets.js";
import {
  gitStatus,
  hashContent,
  pathType,
  toPosix,
  treeSignature,
  walkTree,
  type PathType,
} from "./util/fs.js";
import { parseGeneratedSource } from "./engine/rules.js";

export interface PathState {
  presetId: string;
  relPath: string;
  type: PathType;
  linkText?: string;
}

export interface ConcernScan {
  concern: ConcernKind;
  states: Map<string, PathState>;
  sources: string[];
  links: string[];
  brokenLinks: string[];
}

export interface GeneratedFileInfo {
  dirPresetId: string;
  fileName: string;
  sourceRelPath: string;
}

export interface Detection {
  root: string;
  concerns: Record<ConcernKind, ConcernScan>;
  fileHashes: Map<string, string>;
  dirSignatures: Map<string, string>;
  generatedFiles: GeneratedFileInfo[];
  isGitRepo: boolean;
  dirtyPaths: Set<string>;
}

function emptyScan(concern: ConcernKind): ConcernScan {
  return {
    concern,
    states: new Map(),
    sources: [],
    links: [],
    brokenLinks: [],
  };
}

export async function detect(rootAbs: string): Promise<Detection> {
  const concerns = Object.fromEntries(
    (["instructions", "skills", "rules", "plugins"] as ConcernKind[]).map((c) => [
      c,
      emptyScan(c),
    ]),
  ) as Record<ConcernKind, ConcernScan>;

  const fileHashes = new Map<string, string>();
  const dirSignatures = new Map<string, string>();
  const generatedFiles: GeneratedFileInfo[] = [];

  for (const preset of PRESETS) {
    const absPath = path.resolve(rootAbs, preset.path);
    const type = await pathType(absPath);
    const state: PathState = { presetId: preset.id, relPath: preset.path, type };

    if (type === "symlink-file" || type === "symlink-dir") {
      state.linkText = toPosix(await fsp.readlink(absPath));
      concerns[preset.concern].links.push(preset.id);
    } else if (type === "broken-symlink") {
      state.linkText = toPosix(await fsp.readlink(absPath));
      concerns[preset.concern].brokenLinks.push(preset.id);
    } else if (type === "file" || type === "dir") {
      concerns[preset.concern].sources.push(preset.id);
      if (type === "file") {
        const content = await fsp.readFile(absPath);
        fileHashes.set(preset.path, hashContent(content));
      } else {
        const entries = await walkTree(absPath);
        dirSignatures.set(preset.path, treeSignature(entries));

        if (preset.adapter) {
          for (const entry of entries) {
            if (!/\.(md|mdc)$/.test(entry.rel)) continue;
            const content = await fsp.readFile(path.join(absPath, entry.rel), "utf8");
            const src = parseGeneratedSource(content);
            if (src) {
              generatedFiles.push({
                dirPresetId: preset.id,
                fileName: entry.rel,
                sourceRelPath: src,
              });
            }
          }
        }
      }
    }

    concerns[preset.concern].states.set(preset.id, state);
  }

  const git = gitStatus(rootAbs);

  return {
    root: rootAbs,
    concerns,
    fileHashes,
    dirSignatures,
    generatedFiles,
    isGitRepo: git.isRepo,
    dirtyPaths: git.dirtyPaths,
  };
}

export function describeState(state: PathState | undefined): string {
  if (!state || state.type === "missing") return "not set up";
  switch (state.type) {
    case "file":
    case "dir":
      return "exists";
    case "symlink-file":
    case "symlink-dir":
      return `linked -> ${state.linkText ?? "?"}`;
    case "broken-symlink":
      return `BROKEN link -> ${state.linkText ?? "?"}`;
  }
}
