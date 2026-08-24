import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function makeProject(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agents-aliases-test-"));
}

export async function writeRel(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

export async function linkRel(root: string, linkPath: string, targetText: string): Promise<void> {
  const abs = path.join(root, linkPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await symlink(targetText, abs);
}
