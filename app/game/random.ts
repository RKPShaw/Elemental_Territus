import type { RandomSource } from "./types";

export class SeededRandom implements RandomSource {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x6d2b79f5;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }
}

export function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function cellNoise(seed: number, x: number, y: number): number {
  let value = seed ^ Math.imul(x + 31, 374761393) ^ Math.imul(y + 17, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

const smoothstep = (value: number) => value * value * (3 - 2 * value);
const lerp = (start: number, end: number, amount: number) =>
  start + (end - start) * amount;

/** Bilinearly interpolated value noise for coastlines and biome contours. */
export function smoothCellNoise(
  seed: number,
  x: number,
  y: number,
  scale: number,
): number {
  const scaledX = x / Math.max(1, scale);
  const scaledY = y / Math.max(1, scale);
  const gridX = Math.floor(scaledX);
  const gridY = Math.floor(scaledY);
  const tx = smoothstep(scaledX - gridX);
  const ty = smoothstep(scaledY - gridY);
  const top = lerp(
    cellNoise(seed, gridX, gridY),
    cellNoise(seed, gridX + 1, gridY),
    tx,
  );
  const bottom = lerp(
    cellNoise(seed, gridX, gridY + 1),
    cellNoise(seed, gridX + 1, gridY + 1),
    tx,
  );
  return lerp(top, bottom, ty);
}
