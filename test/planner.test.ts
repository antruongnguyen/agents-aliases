import path from "node:path";
import { describe, expect, it } from "vitest";

import { detect } from "../src/detect.js";
import {
  applyPlan,
  makeDefaultChoices,
  plan,
  type Action,
  type Choices,
  type Plan,
} from "../src/engine/planner.js";
import { linkRel, makeProject, writeRel } from "./helpers.js";

type SymlinkAction = Extract<Action, { kind: "symlink" }>;
type GenerateAction = Extract<Action, { kind: "generate" }>;

const symlinkActions = (p: Plan, targetPath?: string): SymlinkAction[] =>
  p.actions.filter(
    (a): a is SymlinkAction =>
      a.kind === "symlink" && (targetPath === undefined || a.targetPath === targetPath),
  );

const generateActions = (p: Plan): GenerateAction[] =>
  p.actions.filter((a): a is GenerateAction => a.kind === "generate");

const ALL = (detection: Awaited<ReturnType<typeof detect>>): Choices =>
  makeDefaultChoices(detection, { all: true });

describe("plan: instructions", () => {
  it("creates aliases for every missing agent target", async () => {
    const root = await makeProject();
    await writeRel(root, "AGENTS.md", "# agents\n");
    const d = await detect(root);
    const p = await plan(d, ALL(d));

    expect(p.actions.filter((a) => a.kind === "symlink" && a.op === "create")).toHaveLength(3);
    expect(p.blocked).toHaveLength(0);

    await applyPlan(d, p, false);
    const fsp = await import("node:fs/promises");
    const claude = await fsp.readlink(path.join(root, "CLAUDE.md"));
    expect(claude).toBe("AGENTS.md");
  });

  it("scaffolds AGENTS.md when no instruction file exists", async () => {
    const root = await makeProject();
    const d = await detect(root);
    const choices = ALL(d);
    expect(choices.instructions.enabled).toBe(true);
    expect(choices.instructions.canonicalId).toBe("codex");

    const p = await plan(d, choices);
    expect(p.actions.some((a) => a.kind === "scaffold")).toBe(true);

    const summary = await applyPlan(d, p, false);
    expect(summary.scaffolded).toBe(1);
    const fsp = await import("node:fs/promises");
    const stub = await fsp.readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(stub).toContain("# Project Instructions");
  });

  it("replaces identical duplicates safely", async () => {
    const root = await makeProject();
    await writeRel(root, "AGENTS.md", "# same\n");
    await writeRel(root, "CLAUDE.md", "# same\n");
    const d = await detect(root);
    const p = await plan(d, ALL(d));

    const claudeAction = symlinkActions(p, "CLAUDE.md")[0];
    expect(claudeAction?.op).toBe("replace");

    await applyPlan(d, p, false);
    const fsp = await import("node:fs/promises");
    const lst = await fsp.lstat(path.join(root, "CLAUDE.md"));
    expect(lst.isSymbolicLink()).toBe(true);
  });

  it("blocks differing duplicates when not a git repo", async () => {
    const root = await makeProject();
    await writeRel(root, "AGENTS.md", "# agents\n");
    await writeRel(root, "CLAUDE.md", "# claude specific stuff\n");
    const d = await detect(root);
    const p = await plan(d, ALL(d));

    expect(p.blocked.join("\n")).toContain("CLAUDE.md");
    expect(
      p.actions.filter((a) => a.kind === "symlink" && a.targetPath === "CLAUDE.md"),
    ).toHaveLength(0);
  });

  it("replaces differing duplicates in a clean git repo", async () => {
    const root = await makeProject();
    await writeRel(root, "AGENTS.md", "# agents\n");
    await writeRel(root, "CLAUDE.md", "# claude\n");
    const d = await detect(root);
    d.isGitRepo = true;
    const p = await plan(d, ALL(d));

    const claudeAction = symlinkActions(p, "CLAUDE.md")[0];
    expect(claudeAction?.op).toBe("replace");
    expect(claudeAction?.note).toContain("git history");
  });

  it("blocks replacement of dirty files even in git repos", async () => {
    const root = await makeProject();
    await writeRel(root, "AGENTS.md", "# agents\n");
    await writeRel(root, "CLAUDE.md", "# claude\n");
    const d = await detect(root);
    d.isGitRepo = true;
    d.dirtyPaths.add("CLAUDE.md");
    const p = await plan(d, ALL(d));
    expect(p.blocked.join("\n")).toContain("uncommitted");
  });

  it("counts correct existing links as noop and repairs wrong ones", async () => {
    const root = await makeProject();
    await writeRel(root, "AGENTS.md", "# agents\n");
    await linkRel(root, "CLAUDE.md", "AGENTS.md");
    await linkRel(root, ".github/copilot-instructions.md", "../../wrong.md");
    const d = await detect(root);
    const p = await plan(d, ALL(d));

    const repairs = p.actions.filter(
      (a) => a.kind === "symlink" && a.op === "repair",
    ) as SymlinkAction[];
    expect(repairs.map((a) => a.targetPath)).toEqual([".github/copilot-instructions.md"]);
    expect(p.noopCount).toBeGreaterThanOrEqual(1);
  });
});

describe("plan: skills", () => {
  it("replaces identical skill trees and blocks differing ones", async () => {
    const root = await makeProject();
    await writeRel(root, ".agents/skills/alpha/SKILL.md", "alpha\n");
    await writeRel(root, ".claude/skills/alpha/SKILL.md", "alpha\n");
    await writeRel(root, ".codex/skills/beta/SKILL.md", "beta\n");
    const d = await detect(root);
    const p = await plan(d, ALL(d));

    const claudeAction = symlinkActions(p, ".claude/skills")[0];
    expect(claudeAction?.op).toBe("replace");
    expect(p.blocked.join("\n")).toContain(".codex/skills");
  });
});

describe("plan: rules", () => {
  it("generates adapters for missing rule dirs with correct names", async () => {
    const root = await makeProject();
    await writeRel(root, ".cursor/rules/review.mdc", "---\ndescription: Review\n---\nDo review.\n");
    const d = await detect(root);
    const p = await plan(d, ALL(d));

    const targets = p.actions
      .filter((a) => a.kind === "generate")
      .map((a) => (a.kind === "generate" ? a.targetPath : ""))
      .sort();
    expect(targets).toEqual([
      ".github/instructions/review.instructions.md",
      ".windsurf/rules/review.md",
    ]);

    const summary = await applyPlan(d, p, false);
    expect(summary.generated).toBe(2);
  });

  it("regenerates drifted generated files and counts fresh ones as noop", async () => {
    const root = await makeProject();
    await writeRel(root, ".cursor/rules/review.mdc", "---\ndescription: Review\n---\nDo review.\n");
    await writeRel(
      root,
      ".windsurf/rules/review.md",
      "---\ntrigger: glob\ndescription: Review\n---\n<!-- GENERATED by agents-aliases. Source: .cursor/rules/review.mdc. DO NOT EDIT. -->\n\nWRONG BODY.\n",
    );
    const d = await detect(root);
    const p = await plan(d, ALL(d));

    const regen = generateActions(p).filter((a) => a.op === "regenerate");
    expect(regen.map((a) => a.targetPath)).toEqual([
      ".windsurf/rules/review.md",
    ]);
  });

  it("blocks dirs containing foreign rule files", async () => {
    const root = await makeProject();
    await writeRel(root, ".cursor/rules/review.mdc", "---\ndescription: R\n---\nbody\n");
    await writeRel(root, ".windsurf/rules/local-only.md", "custom\n");
    const d = await detect(root);
    const p = await plan(d, ALL(d));
    expect(p.blocked.join("\n")).toContain("local-only.md");
    expect(
      generateActions(p).filter((a) => a.targetPath.startsWith(".windsurf/rules")),
    ).toHaveLength(0);
  });

  it("never overwrites an authored file that lacks the marker", async () => {
    const root = await makeProject();
    await writeRel(root, ".cursor/rules/review.mdc", "---\ndescription: R\n---\nbody\n");
    await writeRel(root, ".windsurf/rules/review.md", "# my own hand-written rule\n");
    const d = await detect(root);
    const p = await plan(d, ALL(d));

    expect(p.blocked.join("\n")).toContain(".windsurf/rules/review.md");
    expect(
      generateActions(p).filter((a) => a.targetPath === ".windsurf/rules/review.md"),
    ).toHaveLength(0);

    const summary = await applyPlan(d, p, false);
    const fsp = await import("node:fs/promises");
    const untouched = await fsp.readFile(path.join(root, ".windsurf/rules/review.md"), "utf8");
    expect(untouched).toBe("# my own hand-written rule\n");
    expect(summary.errors).toHaveLength(0);
  });
});

describe("applyPlan dry run", () => {
  it("makes no filesystem changes when dryRun is true", async () => {
    const root = await makeProject();
    await writeRel(root, "AGENTS.md", "# agents\n");
    const d = await detect(root);
    const p = await plan(d, ALL(d));
    const summary = await applyPlan(d, p, true);
    expect(summary.created).toBe(3);
    const fsp = await import("node:fs/promises");
    await expect(fsp.readFile(path.join(root, "CLAUDE.md"), "utf8")).rejects.toThrow(/ENOENT/);
  });
});
