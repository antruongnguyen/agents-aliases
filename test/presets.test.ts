import { describe, expect, it } from "vitest";

import {
  CONCERN_ORDER,
  PRESETS,
  expandAgentList,
  findPreset,
  findPresetByPath,
  presetsByConcern,
} from "../src/presets.js";
import { targetFileName } from "../src/engine/rules.js";

describe("presets", () => {
  it("has unique ids and paths", () => {
    const ids = new Set(PRESETS.map((p) => p.id));
    const paths = new Set(PRESETS.map((p) => p.path));
    expect(ids.size).toBe(PRESETS.length);
    expect(paths.size).toBe(PRESETS.length);
  });

  it("covers all concerns", () => {
    for (const concern of CONCERN_ORDER) {
      expect(presetsByConcern(concern).length).toBeGreaterThan(0);
    }
  });

  it("orders canonical candidates with AGENTS.md first for instructions", () => {
    expect(presetsByConcern("instructions")[0]?.id).toBe("codex");
    expect(presetsByConcern("skills")[0]?.id).toBe("skills-shared");
  });

  it("finds presets by id and path", () => {
    expect(findPreset("claude")?.path).toBe("CLAUDE.md");
    expect(findPresetByPath(".cursor/rules")?.tool).toBe("Cursor");
    expect(findPresetByPath("nope.md")).toBeUndefined();
  });

  it("expands agent shortcuts", () => {
    const set = expandAgentList("claude,cursor");
    expect(set.has("claude")).toBe(true);
    expect(set.has("skills-claude")).toBe(true);
    expect(set.has("plugins-claude")).toBe(true);
    expect(set.has("rules-claude")).toBe(true);
    expect(set.has("rules-cursor")).toBe(true);
    expect(set.has("codex")).toBe(false);
  });

  it("maps rule file names per adapter", () => {
    expect(targetFileName("review.md", "claude")).toBe("review.md");
    expect(targetFileName("review.mdc", "claude")).toBe("review.md");
    expect(targetFileName("review.md", "mdc")).toBe("review.mdc");
    expect(targetFileName("review.mdc", "copilot-instructions")).toBe("review.instructions.md");
    expect(targetFileName("review.instructions.md", "windsurf")).toBe("review.md");
  });
});
