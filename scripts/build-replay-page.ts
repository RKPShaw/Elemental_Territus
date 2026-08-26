/**
 * Bakes a captured playthrough into one self-contained page.
 *
 * The viewer template ships with a placeholder where its data goes; this fills
 * it. Reads either the single JSON document that a tick-counted capture writes
 * or the line-per-frame file that a time-lapse appends as it runs -- so a page
 * can be built from a capture that is still going, or from one that was cut
 * short, without waiting for or mourning the rest.
 *
 *   npm run build:replay -- --in timelapse.jsonl --out timelapse.html
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "./sim/args";

const args = parseArgs(process.argv.slice(2));
const input = args.flag("in") ?? "replay.json";
const out = args.flag("out") ?? "replay.html";
const template = args.flag("template") ?? "scripts/replay-viewer.template.html";

const raw = readFileSync(input, "utf8").trim();
let replay: Record<string, unknown>;

if (raw.startsWith("{") && !raw.includes("\n{")) {
  replay = JSON.parse(raw) as Record<string, unknown>;
} else {
  const lines = raw.split("\n").filter((line) => line.length > 0);
  const [header, ...frameLines] = lines;
  // A run killed mid-write can leave a truncated last line; drop it rather than
  // lose the whole capture to it.
  const frames: unknown[] = [];
  for (const line of frameLines) {
    try {
      frames.push(JSON.parse(line));
    } catch {
      process.stderr.write(`  dropped a truncated final frame\n`);
    }
  }
  replay = { ...(JSON.parse(header!) as Record<string, unknown>), frames };
}

const frameCount = (replay.frames as unknown[]).length;
const payload = JSON.stringify(replay)
  // The payload lives inside a <script> tag, so nothing in it may look like the
  // tag's end. Escaping the angle bracket keeps it valid JSON either way.
  .replaceAll("<", "\\u003c");

const page = readFileSync(template, "utf8").replace("__REPLAY_JSON__", () => payload);
writeFileSync(out, page);
process.stderr.write(
  `built ${out} from ${frameCount} frames (${(page.length / 1e6).toFixed(2)}MB)\n`,
);
