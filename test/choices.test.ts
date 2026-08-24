import { describe, expect, it } from "vitest";

import { detect } from "../src/detect.js";
import { makeDefaultChoices } from "../src/engine/planner.js";
import { expandAgentList } from "../src/presets.js";
import { makeProject, writeRel } from "./helpers.js";

describe("makeDefaultChoices", () => {
  it("enables every detected concern and defaults instructions to AGENTS.md", async () => {
    const root = await makeProject();
    await writeRel(root, "AGENTS.md", "# agents\n");
    await writeRel(root, ".claude/skills/x/SKILL.md", "x\n");
    const d = await detect(root);
    const c = makeDefaultChoices(d, { all: true });

    expect(c.instructions).toMatchObject({ enabled: true, canonicalId: "codex" });
    expect(c.instructions.targetIds).toEqual(["claude", "gemini", "copilot"]);
    expect(c.skills).toMatchObject({ enabled: true, canonicalId: "skills-claude" });
    expect(c.rules.enabled).toBe(false);
    expect(c.plugins.enabled).toBe(false);
  });

  it("scaffolds when nothing exists", async () => {
    const root = await makeProject();
    const d = await detect(root);
    const c = makeDefaultChoices(d, {});
    expect(c.instructions.enabled).toBe(true);
    expect(c.instructions.canonicalId).toBe("codex");
  });

  it("filters targets by --agents shortcuts", async () => {
    const root = await makeProject();
    await writeRel(root, "AGENTS.md", "# agents\n");
    const d = await detect(root);
    const c = makeDefaultChoices(d, { agents: expandAgentList("claude") });

    expect(c.instructions.targetIds).toEqual(["claude"]);
    expect(c.skills.enabled).toBe(false);
  });

  it("disables a concern whose canonical is filtered out", async () => {
    const root = await makeProject();
    await writeRel(root, ".claude/skills/x/SKILL.md", "x\n");
    const d = await detect(root);
    const c = makeDefaultChoices(d, { agents: expandAgentList("cursor") });
    expect(c.skills.enabled).toBe(false);
    expect(c.skills.targetIds).toEqual([]);
  });
});
