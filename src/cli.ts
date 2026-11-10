import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
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
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        approve: { type: "string" },
        "skip-drift": { type: "boolean" },
        "allow-large": { type: "boolean" },
      },
    });
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 64;
  }
  const [command, file, ...extra] = parsed.positionals;
  if (!command || !file || extra.length || !["check", "apply"].includes(command)) {
    console.error(USAGE);
    return 64;
  }
  const { approve, "skip-drift": skipDrift, "allow-large": allowLarge } = parsed.values;

  const io: Io = {
    out: (line) => console.log(line),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      // Ctrl+C at the prompt reaches readline, not the process: abort the
      // question so apply unwinds and releases its lock.
      const abort = new AbortController();
      rl.on("SIGINT", () => abort.abort());
      try {
        return await rl.question(question, { signal: abort.signal });
      } finally {
        rl.close();
      }
    },
  };

  const plan = await readPlan(file);
  if (command === "check") {
    const p = await preview(plan, io, { allowLarge });
    return p.drifted > 0 ? 2 : 0;
  }

  const r = await apply(plan, io, { approve, skipDrift, allowLarge });
  io.out(`applied: ${r.applied}, skipped for drift: ${r.skipped}`);
  io.out(`log and rollback: ${r.dir}`);
  if (r.stopped) {
    io.out(`stopped: ${r.stopped}`);
    return 1;
  }
  return 0;
}

// exitCode, not process.exit(): output still queued for a pipe gets written.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
