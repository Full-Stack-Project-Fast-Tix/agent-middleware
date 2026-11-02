import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HttpError } from "./errors.js";

/** `~` and `~/x` mean the server user's home folder. */
export function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
}

/**
 * The real path of the folder a new workspace's Runs copy, when it lies inside
 * one of `roots`. Symlinks are resolved first on both sides, so a link cannot
 * lead out of a root. No roots means the server does not let anyone choose.
 */
export async function allowedSourcePath(requested: string, roots: readonly string[]): Promise<string> {
  if (roots.length === 0) {
    throw new HttpError(400, "This server does not let workspaces choose a folder. Set WORKSPACE_SOURCE_ROOTS to allow it.");
  }
  const expanded = expandHome(requested.trim());
  if (!path.isAbsolute(expanded)) throw new HttpError(400, "The folder must be a full path, such as ~/projects/app.");
  const real = await realpath(expanded).catch(() => null);
  if (real === null || !(await stat(real)).isDirectory()) throw new HttpError(400, "That folder does not exist on the server.");
  for (const root of roots) {
    const realRoot = await realpath(root).catch(() => null);
    if (realRoot === null) continue;
    const relative = path.relative(realRoot, real);
    if (relative === "" || (relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative))) return real;
  }
  throw new HttpError(400, `The folder must be inside ${roots.join(" or ")}.`);
}
