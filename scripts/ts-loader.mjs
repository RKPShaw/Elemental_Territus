/**
 * Runs the TypeScript sources directly on Node, with no dependencies.
 *
 * The game's modules import each other without file extensions, the way the
 * bundler resolves them, but Node's ESM resolver requires a full specifier.
 * This hook fills that gap so `app/game` — which imports nothing outside
 * itself — can run from a bare checkout, before or without `npm ci`.
 *
 * Node strips the types; this only resolves the paths. Use it as:
 *
 *   node --experimental-transform-types --import ./scripts/ts-loader.mjs <entry.ts>
 *
 * `--experimental-transform-types` rather than plain type stripping is required
 * only because ElementalWarEngine's constructor declares parameter properties.
 */
import { register } from "node:module";

register("./ts-loader-hooks.mjs", import.meta.url);
