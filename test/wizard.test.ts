import { describe, expect, it, vi } from "vitest";

const confirmMock = vi.fn(async () => true);
const selectMock = vi.fn(async (opts: { initialValue?: string }) => opts.initialValue);
const searchMock = vi.fn(async (opts: { items: { value: string }[] }) =>
  opts.items.map((i) => i.value),
);

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  log: { message: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), step: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  confirm: (...args: unknown[]) => confirmMock(...(args as [])),
  select: ((opts: { initialValue?: string }) => selectMock(opts)) as unknown,
  isCancel: () => false,
  text: vi.fn(async () => ""),
}));

vi.mock("../src/ui/search-multiselect.js", () => ({
  cancelSymbol: Symbol("cancel"),
  searchMultiselect: (opts: { items: { value: string }[] }) => searchMock(opts),
}));

import { detect } from "../src/detect.js";
import { runWizard } from "../src/ui/prompts.js";
import { presetsByConcern } from "../src/presets.js";
import { makeProject, writeRel } from "./helpers.js";

describe("runWizard (defaults accepted)", () => {
  it("wires every detected concern to every agent when the user just hits enter", async () => {
    const root = await makeProject();
    await writeRel(root, "AGENTS.md", "# agents\n");
    await writeRel(root, ".agents/skills/x/SKILL.md", "x\n");
    await writeRel(root, ".cursor/rules/ts.mdc", "---\ndescription: t\n---\nb\n");
    await writeRel(root, ".claude/plugins/p.json", "{}\n");

    const d = await detect(root);
    const choices = await runWizard(d);
    expect(choices).not.toBeNull();

    expect(choices!.instructions).toEqual({
      enabled: true,
      canonicalId: "codex",
      targetIds: ["claude", "gemini", "copilot"],
    });
    expect(choices!.skills.canonicalId).toBe("skills-shared");
    expect(choices!.skills.targetIds).toEqual(
      presetsByConcern("skills").map((p) => p.id).filter((id) => id !== "skills-shared"),
    );
    expect(choices!.rules.canonicalId).toBe("rules-cursor");
    // plugins has a single preset — it is its own canonical, nothing to link
    expect(choices!.plugins.enabled).toBe(false);
    expect(searchMock).toHaveBeenCalled();
  });

  it("offers scaffolding when no instruction file exists at all", async () => {
    const root = await makeProject();
    const d = await detect(root);
    const choices = await runWizard(d);
    expect(choices!.instructions).toEqual({
      enabled: true,
      canonicalId: "codex",
      targetIds: ["claude", "gemini", "copilot"],
    });
  });

  it("excludes an agent the user deselects in the global picker", async () => {
    // Pick claude + copilot only: instructions target claude (not gemini), and the cursor-canonical
    // rules generate an adapter for claude/copilot but not windsurf.
    searchMock.mockImplementationOnce(async () => ["claude", "copilot"]);
    const root = await makeProject();
    await writeRel(root, "AGENTS.md", "# agents\n");
    await writeRel(root, ".cursor/rules/ts.mdc", "---\ndescription: t\n---\nb\n");
    const d = await detect(root);
    const choices = await runWizard(d);
    expect(choices!.instructions.targetIds).toContain("claude");
    expect(choices!.instructions.targetIds).not.toContain("gemini");
    expect(choices!.rules.enabled).toBe(true);
    expect(choices!.rules.targetIds).not.toContain("rules-windsurf");
  });

  it("disables everything when the user selects no agents", async () => {
    searchMock.mockImplementationOnce(async () => []);
    const root = await makeProject();
    await writeRel(root, "AGENTS.md", "# agents\n");
    await writeRel(root, ".agents/skills/x/SKILL.md", "x\n");
    const d = await detect(root);
    const choices = await runWizard(d);
    expect(choices!.instructions.enabled).toBe(false);
    expect(choices!.skills.enabled).toBe(false);
  });
});
