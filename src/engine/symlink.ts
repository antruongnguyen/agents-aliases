import fsp from "node:fs/promises";
import path from "node:path";

import { toPosix } from "../util/fs.js";

export class WindowsSymlinkError extends Error {
  constructor(original: unknown) {
    super(
      "Could not create a symbolic link. On Windows, enable Developer Settings (or run as Administrator / use WSL). See: https://learn.microsoft.com/en-us/windows/apps/get-started/enable-your-device-for-development",
      { cause: original },
    );
    this.name = "WindowsSymlinkError";
  }
}

export function relativeLinkTarget(
  rootAbs: string,
  sourceRel: string,
  targetRel: string,
): string {
  const fromDir = path.dirname(path.resolve(rootAbs, targetRel));
  const toSource = path.resolve(rootAbs, sourceRel);
  return toPosix(path.relative(fromDir, toSource)) || ".";
}

export async function readLinkText(absLink: string): Promise<string> {
  return toPosix(await fsp.readlink(absLink));
}

export async function createSymlink(
  rootAbs: string,
  sourceRel: string,
  targetRel: string,
): Promise<void> {
  const absTarget = path.resolve(rootAbs, targetRel);
  const linkText = relativeLinkTarget(rootAbs, sourceRel, targetRel);
  await fsp.mkdir(path.dirname(absTarget), { recursive: true });
  try {
    await fsp.symlink(linkText, absTarget);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const lst = await fsp.lstat(absTarget);
      if (!lst.isSymbolicLink()) throw err;
      await fsp.unlink(absTarget);
      await fsp.symlink(linkText, absTarget);
      return;
    }
    if (
      process.platform === "win32" &&
      ((err as NodeJS.ErrnoException).code === "EPERM" ||
        (err as NodeJS.ErrnoException).code === "EACCES")
    ) {
      throw new WindowsSymlinkError(err);
    }
    throw err;
  }
}

export async function replaceWithSymlink(
  rootAbs: string,
  sourceRel: string,
  targetRel: string,
): Promise<void> {
  const absTarget = path.resolve(rootAbs, targetRel);
  const linkText = relativeLinkTarget(rootAbs, sourceRel, targetRel);
  await fsp.mkdir(path.dirname(absTarget), { recursive: true });
  try {
    await fsp.symlink(linkText, absTarget + ".agents-aliases-tmp");
    await fsp.rm(absTarget, { recursive: true, force: false });
    await fsp.rename(absTarget + ".agents-aliases-tmp", absTarget);
  } catch (err) {
    await fsp.rm(absTarget + ".agents-aliases-tmp", { force: true, recursive: true }).catch(() => {});
    if (
      process.platform === "win32" &&
      ((err as NodeJS.ErrnoException).code === "EPERM" ||
        (err as NodeJS.ErrnoException).code === "EACCES")
    ) {
      throw new WindowsSymlinkError(err);
    }
    throw err;
  }
}
