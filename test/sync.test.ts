import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runSync } from "../src/commands/sync.js";
import { makeProject, writeRel } from "./helpers.js";

const cwd = process.cwd();

afterEach(() => {
  process.chdir(cwd);
  vi.restoreAllMocks();
});

describe("sync: .clinerules migration", () => {
  it("migrates a stale .clinerules dir in a clean git repo", async () => {
    const root = await makeProject();
    await writeRel(root, ".clinerules/review.md", "# review rule\n");
    // Migration is git-gated; commit the legacy dir so it is clean.
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], {
      cwd: root,
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    process.chdir(root);
    const code = await runSync(false);
    expect(code).toBe(0);

    const migrated = await fsp.readFile(path.join(root, ".cline/rules/review.md"), "utf8");
    expect(migrated).toBe("# review rule\n");
    await expect(fsp.stat(path.join(root, ".clinerules"))).rejects.toThrow(/ENOENT/);
  });
});
