/**
 * Measures how each system's cost scales with the roster size.
 *
 * A single profile tells you what is slow; it does not tell you *why* a system
 * gets slower as players are added. Running the same profile across roster
 * sizes and fitting the growth exponent does: a system that is linear in the
 * player count is a different problem from one that is quadratic in it, and
 * they want different fixes.
 *
 *   npm run scaling -- --counts 5,10,25,50 --ticks 40
 *
 * Each roster size runs in its own child process, because the roster is fixed
 * when app/game/players.ts loads.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./sim/args";

const args = parseArgs(process.argv.slice(2));
const counts = (args.flag("counts") ?? "5,10,25,50")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isFinite(value) && value > 0);
const ticks = args.integer("ticks", 40);
const warmup = args.integer("warmup", 3);
const seed = args.number("seed", 0x240823);

interface Measurement {
  players: number;
  totalMs: number;
  worldMs: number;
  systems: Record<string, number>;
}

/** The child prints one JSON line; anything else is progress noise. */
function measure(players: number): Measurement {
  const child = fileURLToPath(new URL("./scaling-child.ts", import.meta.url));
  const output = execFileSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--disable-warning=ExperimentalWarning",
      "--import",
      fileURLToPath(new URL("./ts-loader.mjs", import.meta.url)),
      child,
      String(ticks),
      String(seed),
      String(warmup),
    ],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ELEMENTAL_PLAYERS_PER_ELEMENT: String(players / 5) },
    },
  );
  return JSON.parse(output.trim().split("\n").at(-1)!) as Measurement;
}

const results: Measurement[] = [];
for (const players of counts) {
  process.stderr.write(`measuring ${players} players...\n`);
  results.push(measure(players));
}

/**
 * Growth exponent from the first to the last roster size: cost ~ players^k.
 * k near 0 is flat, 1 is linear, 2 is quadratic.
 */
function exponent(first: Measurement, last: Measurement, key: string): number {
  const a = first.systems[key] ?? 0;
  const b = last.systems[key] ?? 0;
  if (a <= 0 || b <= 0) return 0;
  return Math.log(b / a) / Math.log(last.players / first.players);
}

function shape(k: number): string {
  if (k < 0.35) return "flat";
  if (k < 0.75) return "sublinear";
  if (k < 1.4) return "linear";
  if (k < 1.75) return "superlinear";
  return "quadratic";
}

const first = results[0]!;
const last = results.at(-1)!;
const names = [...new Set(results.flatMap((r) => Object.keys(r.systems)))];
names.sort((a, b) => (last.systems[b] ?? 0) - (last.systems[a] ?? 0));

const pad = (text: string, width: number) => text.padEnd(width);
const num = (value: number, width: number) => value.toFixed(1).padStart(width);

process.stdout.write(`\nms per tick by roster size (seed 0x${seed.toString(16)}, ${ticks} ticks after ${warmup} warm-up)\n\n`);
process.stdout.write(
  `${pad("system", 42)}${results.map((r) => String(r.players).padStart(9)).join("")}` +
  `${"growth".padStart(13)}  shape\n`,
);
process.stdout.write("-".repeat(42 + results.length * 9 + 13 + 12) + "\n");
for (const name of names) {
  const k = exponent(first, last, name);
  process.stdout.write(
    `${pad(name, 42)}${results.map((r) => num(r.systems[name] ?? 0, 9)).join("")}` +
    `${`x${(( last.systems[name] ?? 0) / Math.max(0.001, first.systems[name] ?? 0)).toFixed(0)}`.padStart(9)}` +
    `${k.toFixed(2).padStart(6)}  ${shape(k)}\n`,
  );
}
process.stdout.write("-".repeat(42 + results.length * 9 + 13 + 12) + "\n");
process.stdout.write(
  `${pad("TOTAL tick", 42)}${results.map((r) => num(r.totalMs, 9)).join("")}\n`,
);
process.stdout.write(
  `${pad("world creation (once)", 42)}${results.map((r) => num(r.worldMs, 9)).join("")}\n\n`,
);

const budget = 1000 / 16;
process.stdout.write(`budget for 16 ticks/second: ${budget.toFixed(1)}ms per tick\n`);
for (const result of results) {
  const verdict = result.totalMs <= budget ? "meets" : `${(result.totalMs / budget).toFixed(1)}x over`;
  process.stdout.write(
    `  ${String(result.players).padStart(4)} players: ${result.totalMs.toFixed(1)}ms  ${verdict}\n`,
  );
}
