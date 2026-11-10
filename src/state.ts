import { homedir } from "node:os";
import { join } from "node:path";
import { rename, rm, writeFile } from "node:fs/promises";

/** Root for this server's data (snapshots, plans): outside the install folder, which updates replace. */
export function stateDir(...sub: string[]): string {
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "clickup-mcp-extras", ...sub);
}

/**
 * Write via a temp file in the same directory, then rename: readers (and a run
 * killed mid-write) never see half a file. Owner-only (0600).
 */
export async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
