/**
 * Exact euclidean distance to the nearest of a set of cells, for every cell.
 *
 * The build planner scores candidate tiles against lists of sites -- track
 * cells, rival trade hubs -- by taking the minimum distance to the list. Done
 * directly that is one pass over the list per candidate, and with a thousand
 * track cells and a hundred players it becomes tens of millions of distance
 * computations a tick.
 *
 * A distance transform answers the same question for every cell in two passes
 * over the grid, regardless of how many sites are in the set. This is the exact
 * transform of Felzenszwalb and Huttenlocher, not an approximation: it returns
 * the same values the pairwise minimum did, so scoring is unchanged.
 */

const INFINITY = 1e20;

/** Lower envelope of parabolas along one axis; the core of the exact transform. */
function transform1d(source: Float64Array, length: number, scratch: {
  parabola: Int32Array;
  boundary: Float64Array;
  values: Float64Array;
}): void {
  const { parabola, boundary, values } = scratch;
  let rightmost = 0;
  parabola[0] = 0;
  boundary[0] = -INFINITY;
  boundary[1] = INFINITY;

  for (let q = 1; q < length; q += 1) {
    let intersection = (source[q]! + q * q - (source[parabola[rightmost]!]! + parabola[rightmost]! * parabola[rightmost]!))
      / (2 * q - 2 * parabola[rightmost]!);
    while (intersection <= boundary[rightmost]!) {
      rightmost -= 1;
      intersection = (source[q]! + q * q - (source[parabola[rightmost]!]! + parabola[rightmost]! * parabola[rightmost]!))
        / (2 * q - 2 * parabola[rightmost]!);
    }
    rightmost += 1;
    parabola[rightmost] = q;
    boundary[rightmost] = intersection;
    boundary[rightmost + 1] = INFINITY;
  }

  rightmost = 0;
  for (let q = 0; q < length; q += 1) {
    while (boundary[rightmost + 1]! < q) rightmost += 1;
    const p = parabola[rightmost]!;
    values[q] = (q - p) * (q - p) + source[p]!;
  }
  for (let q = 0; q < length; q += 1) source[q] = values[q]!;
}

export interface DistanceField {
  /** Squared distance in cells to the nearest seed, per cell index. */
  squared: Float64Array;
}

/**
 * Squared euclidean distance in cells from every cell to the nearest seed.
 * An empty seed set yields a field of Infinity, matching a minimum over nothing.
 */
export function buildDistanceField(
  seeds: readonly number[],
  width: number,
  height: number,
): DistanceField {
  const squared = new Float64Array(width * height).fill(INFINITY);
  if (seeds.length === 0) return { squared };
  for (const seed of seeds) squared[seed] = 0;

  const longest = Math.max(width, height);
  const column = new Float64Array(longest);
  const scratch = {
    parabola: new Int32Array(longest),
    boundary: new Float64Array(longest + 1),
    values: new Float64Array(longest),
  };

  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) column[y] = squared[y * width + x]!;
    transform1d(column, height, scratch);
    for (let y = 0; y < height; y += 1) squared[y * width + x] = column[y]!;
  }
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) column[x] = squared[row + x]!;
    transform1d(column, width, scratch);
    for (let x = 0; x < width; x += 1) squared[row + x] = column[x]!;
  }
  return { squared };
}

/** Distance in cells from a cell to the nearest seed, or Infinity if none. */
export function distanceAt(field: DistanceField, index: number): number {
  const squared = field.squared[index]!;
  return squared >= INFINITY ? Number.POSITIVE_INFINITY : Math.sqrt(squared);
}
