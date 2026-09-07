import { describe, expect, it } from "vitest";

import { renderSetupSummary, summarizePlan } from "../src/ui/summary.js";
import type { Plan } from "../src/engine/planner.js";

const basePlan: Plan = { actions: [], noopCount: 0, warnings: [], blocked: [], conflicts: [] };

describe("summarizePlan", () => {
  it("groups symlink actions by canonical path", () => {
    const plan: Plan = {
      ...basePlan,
      actions: [
        { kind: "scaffold", path: "AGENTS.md" },
        { kind: "symlink", op: "create", targetPath: "CLAUDE.md", canonicalPath: "AGENTS.md" },
        {
          kind: "symlink",
          op: "create",
          targetPath: ".github/copilot-instructions.md",
          canonicalPath: "AGENTS.md",
        },
        {
          kind: "symlink",
          op: "replace",
          targetPath: ".codex/skills",
          canonicalPath: ".claude/skills",
          note: "content identical",
        },
      ],
    };
    const s = summarizePlan(plan);
    expect(s.scaffolds).toEqual(["AGENTS.md"]);
    expect(s.canonicalGroups).toHaveLength(2);

    const instructions = s.canonicalGroups[0]!;
    expect(instructions.concern).toBe("instructions");
    expect(instructions.creates).toEqual(["CLAUDE.md", ".github/copilot-instructions.md"]);

    const skills = s.canonicalGroups[1]!;
    expect(skills.replaces).toEqual([".codex/skills"]);
  });

  it("groups generated adapter files under their target dir", () => {
    const plan: Plan = {
      ...basePlan,
      actions: [
        {
          kind: "generate",
          op: "create",
          targetPath: ".windsurf/rules/review.md",
          sourceRelPath: ".cursor/rules/review.mdc",
          format: "windsurf",
        },
      ],
    };
    const s = summarizePlan(plan);
    expect(s.generatedGroups).toEqual([{ targetDir: ".windsurf/rules", files: ["review.md"] }]);
  });

  it("carries warnings and blocked entries through", () => {
    const s = summarizePlan({
      ...basePlan,
      warnings: ["w1"],
      blocked: ["b1"],
      noopCount: 2,
    });
    expect(s.warnings).toEqual(["w1"]);
    expect(s.blocked).toEqual(["b1"]);
    expect(s.noopCount).toBe(2);
  });
});

describe("renderSetupSummary", () => {
  it("renders a skills-style overview with canonical paths and targets", () => {
    const plan: Plan = {
      ...basePlan,
      actions: [
        { kind: "symlink", op: "create", targetPath: "CLAUDE.md", canonicalPath: "AGENTS.md" },
        { kind: "symlink", op: "create", targetPath: "GEMINI.md", canonicalPath: "AGENTS.md" },
      ],
      warnings: ["something to note"],
    };
    const out = renderSetupSummary(plan);
    expect(out).toContain("AGENTS.md");
    expect(out).toContain("link:");
    // vitest sets NO_COLOR (see vitest.config.ts), so picocolors emits plain labels
    expect(out).toContain("Claude Code (CLAUDE.md)");
    expect(out).toContain("! something to note");
  });

  it("renders blocked entries and noop counts", () => {
    const out = renderSetupSummary({ ...basePlan, blocked: ["nope"], noopCount: 3 });
    expect(out).toContain("x nope");
    expect(out).toContain("already up to date: 3");
  });

  it("renders scaffold actions as new files", () => {
    const out = renderSetupSummary({ ...basePlan, actions: [{ kind: "scaffold", path: "AGENTS.md" }] });
    expect(out).toContain("+ AGENTS.md");
    expect(out).toContain("(new)");
  });
});
