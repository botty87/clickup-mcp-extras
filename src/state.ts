import { homedir } from "node:os";
import { join } from "node:path";

/** Root for this server's data (snapshots, plans): outside the install folder, which updates replace. */
export function stateDir(...sub: string[]): string {
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "clickup-mcp-extras", ...sub);
}
