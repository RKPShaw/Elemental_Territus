/** Flag parsing shared by every `sim` subcommand. */

export interface ParsedArgs {
  command: string;
  positional: string[];
  flag(name: string): string | undefined;
  number(name: string, fallback: number): number;
  integer(name: string, fallback: number): number;
  boolean(name: string, fallback: boolean): boolean;
  has(name: string): boolean;
}

/**
 * Accepts `--flag value`, `--flag=value`, bare `--flag`, and `--no-flag`.
 * Deliberately tiny: the repo has no argument-parsing dependency and this only
 * ever reads flags a developer typed by hand.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals >= 0) {
      values.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    if (body.startsWith("no-")) {
      values.set(body.slice(3), "false");
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      values.set(body, "true");
      continue;
    }
    values.set(body, next);
    index += 1;
  }

  const flag = (name: string) => values.get(name);
  const number = (name: string, fallback: number) => {
    const raw = values.get(name);
    if (raw === undefined) return fallback;
    // Seeds are habitually written in hex, so honour the 0x form.
    const parsed = raw.startsWith("0x") || raw.startsWith("0X")
      ? Number.parseInt(raw.slice(2), 16)
      : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    command: positional[0] ?? "help",
    positional: positional.slice(1),
    flag,
    number,
    integer: (name, fallback) => Math.trunc(number(name, fallback)),
    boolean: (name, fallback) => {
      const raw = values.get(name);
      if (raw === undefined) return fallback;
      return raw !== "false" && raw !== "0";
    },
    has: (name) => values.has(name),
  };
}

export const DEFAULT_SEED = 0x240823;

/** Colour is on for a TTY unless `--no-color` or NO_COLOR says otherwise. */
export function wantsColor(args: ParsedArgs): boolean {
  if (process.env.NO_COLOR !== undefined) return args.boolean("color", false);
  return args.boolean("color", Boolean(process.stdout.isTTY));
}

export function terminalWidth(args: ParsedArgs): number {
  return Math.max(40, args.integer("width", process.stdout.columns || 100));
}
