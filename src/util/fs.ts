import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export type PathType =
  | "missing"
  | "file"
  | "dir"
  | "symlink-file"
  | "symlink-dir"
  | "broken-symlink";

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

export function joinRel(...parts: string[]): string {
  return toPosix(path.join(...parts));
}

export async function pathType(absPath: string): Promise<PathType> {
  let lst;
  try {
    lst = await fsp.lstat(absPath);
  } catch {
    return "missing";
  }
  if (!lst.isSymbolicLink()) {
    return lst.isDirectory() ? "dir" : "file";
  }
  try {
    const st = await fsp.stat(absPath);
    return st.isDirectory() ? "symlink-dir" : "symlink-file";
  } catch {
    return "broken-symlink";
  }
}

export async function readTextIfExists(absPath: string): Promise<string | null> {
  try {
    return await fsp.readFile(absPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export interface TreeEntry {
  rel: string;
  hash: string;
}

export async function walkTree(absDir: string): Promise<TreeEntry[]> {
  const out: TreeEntry[] = [];
  async function visit(rel: string, abs: string): Promise<void> {
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(abs, e.name);
      if (e.isSymbolicLink()) {
        out.push({ rel: childRel, hash: "link:" + toPosix(await fsp.readlink(childAbs)) });
      } else if (e.isDirectory()) {
        await visit(childRel, childAbs);
      } else if (e.isFile()) {
        out.push({ rel: childRel, hash: hashContent(await fsp.readFile(childAbs)) });
      }
    }
  }
  await visit("", absDir);
  return out;
}

export function treeSignature(entries: TreeEntry[]): string {
  return hashContent(entries.map((e) => `${e.rel}\u0000${e.hash}`).join("\n"));
}

export interface GitStatus {
  isRepo: boolean;
  dirtyPaths: Set<string>;
}

export function gitStatus(cwd: string): GitStatus {
  const empty: GitStatus = { isRepo: false, dirtyPaths: new Set() };
  try {
    const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf8",
    });
    if (probe.status !== 0 || probe.stdout?.trim() !== "true") return empty;
    const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd,
      encoding: "utf8",
    });
    const dirty = new Set<string>();
    if (status.status === 0 && status.stdout) {
      for (const line of status.stdout.split("\n")) {
        if (!line.trim()) continue;
        let entry = line.slice(3).trim();
        if (entry.startsWith('"') && entry.endsWith('"')) {
          entry = entry.slice(1, -1);
        }
        if (entry.includes(" -> ")) {
          entry = entry.split(" -> ").pop() ?? entry;
        }
        dirty.add(toPosix(entry).replace(/\/$/, ""));
      }
    }
    return { isRepo: true, dirtyPaths: dirty };
  } catch {
    return empty;
  }
}
