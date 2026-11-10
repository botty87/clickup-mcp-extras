import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { config as dotenvConfig } from "dotenv";
import { apply, preview, readPlan, type Io } from "./plan.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, "..", ".env"), quiet: true });

const USAGE = `Usage:
  node dist/cli.js check <plan.json> [--allow-large]
  node dist/cli.js apply <plan.json> --approve <hash8> [--skip-drift] [--allow-large]

check is read-only. apply writes to ClickUp and must be run by a person in a terminal.
Plan format: docs/plan-format.md`;

async function main(argv: string[]): Promise<number> {
  const [command, file, ...rest] = argv;
  if (!command || !file || !["check", "apply"].includes(command)) {
    console.error(USAGE);
    return 64;
  }
  const flag = (name: string) => rest.includes(name);
  const approveAt = rest.indexOf("--approve");
  const approve = approveAt >= 0 ? rest[approveAt + 1] : undefined;

  const io: Io = {
    out: (line) => console.log(line),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };

  const plan = await readPlan(file);
  if (command === "check") {
    const p = await preview(plan, io, { allowLarge: flag("--allow-large") });
    return p.drifted > 0 ? 2 : 0;
  }

  const r = await apply(plan, io, { approve, skipDrift: flag("--skip-drift"), allowLarge: flag("--allow-large") });
  io.out(`applied: ${r.applied}, skipped for drift: ${r.skipped}`);
  io.out(`log and rollback plan: ${r.dir}`);
  if (r.stopped) {
    io.out(`stopped: ${r.stopped}`);
    return 1;
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
