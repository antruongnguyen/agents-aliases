import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createSymlink,
  relativeLinkTarget,
  WindowsSymlinkError,
} from "../src/engine/symlink.js";
import { linkRel, makeProject, writeRel } from "./helpers.js";
import { pathType } from "../src/util/fs.js";
import fsp from "node:fs/promises";

describe("relativeLinkTarget", () => {
  it("links sibling files", () => {
    expect(relativeLinkTarget("/r", "AGENTS.md", "CLAUDE.md")).toBe("AGENTS.md");
  });

  it("escapes nested directories", () => {
    expect(
      relativeLinkTarget("/r", "AGENTS.md", ".github/copilot-instructions.md"),
    ).toBe("../AGENTS.md");
  });

  it("handles nested-to-nested", () => {
    expect(
      relativeLinkTarget("/r", ".agents/rules/a.md", ".cursor/rules/b.mdc"),
    ).toBe("../../.agents/rules/a.md");
  });
});

describe("createSymlink", () => {
  it("creates parent dirs and a resolving link", async () => {
    const root = await makeProject();
    await writeRel(root, "AGENTS.md", "# hi\n");
    await createSymlink(root, "AGENTS.md", ".github/copilot-instructions.md");
    const t = await pathType(path.join(root, ".github/copilot-instructions.md"));
    expect(t).toBe("symlink-file");
    const content = await fsp.readFile(path.join(root, ".github/copilot-instructions.md"), "utf8");
    expect(content).toBe("# hi\n");
  });

  it("swaps an existing symlink atomically", async () => {
    const root = await makeProject();
    await writeRel(root, "A.md", "A\n");
    await writeRel(root, "B.md", "B\n");
    await createSymlink(root, "A.md", "L.md");
    await createSymlink(root, "B.md", "L.md");
    const text = await fsp.readlink(path.join(root, "L.md"));
    expect(text).toBe("B.md");
  });

  it("refuses to clobber a real file", async () => {
    const root = await makeProject();
    await writeRel(root, "A.md", "A\n");
    await writeRel(root, "L.md", "real content\n");
    await expect(createSymlink(root, "A.md", "L.md")).rejects.toThrow(/EEXIST/);
  });

  it("detects broken links", async () => {
    const root = await makeProject();
    await linkRel(root, "dangling.md", "nowhere.md");
    const t = await pathType(path.join(root, "dangling.md"));
    expect(t).toBe("broken-symlink");
  });

  it("exports a windows-specific error type", () => {
    const err = new WindowsSymlinkError(new Error("x"));
    expect(err.name).toBe("WindowsSymlinkError");
  });
});
