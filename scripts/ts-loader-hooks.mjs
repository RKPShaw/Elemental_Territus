/**
 * Resolve hook backing scripts/ts-loader.mjs. Runs on the loader thread, so it
 * is a separate module from the `register` call that installs it.
 */
import { statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Tried in the order a bundler would, so a directory import finds its index. */
const CANDIDATE_SUFFIXES = [".ts", ".tsx", "/index.ts", "/index.tsx"];

function isFile(path) {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const base = context.parentURL
      ? new URL(specifier, context.parentURL)
      : pathToFileURL(specifier);
    // A specifier that already names a file is left to Node, so its caching and
    // error messages apply. Anything else -- including a bare directory, which
    // Node refuses outright -- gets the bundler's candidate suffixes.
    const path = fileURLToPath(base);
    if (!isFile(path)) {
      for (const suffix of CANDIDATE_SUFFIXES) {
        if (isFile(`${path}${suffix}`)) {
          return { url: pathToFileURL(`${path}${suffix}`).href, shortCircuit: true };
        }
      }
    }
  }
  return nextResolve(specifier, context);
}
