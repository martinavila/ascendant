// Deterministic, serializable PRNG (sfc32). All simulation randomness flows
// through here so a saved game replays identically — reloading can't reroll
// outcomes (the original's xeno-dig save-scum exploit).

export type RngState = [number, number, number, number];

export function seedRng(seed: number): RngState {
  let h = 1779033703 ^ seed;
  const next = () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
  const s: RngState = [next(), next(), next(), next()];
  const r = new Rng(s);
  for (let i = 0; i < 15; i++) r.next();
  return r.state;
}

export class Rng {
  constructor(public state: RngState) {}

  static fromSeed(seed: number) {
    return new Rng(seedRng(seed));
  }

  /** Uniform float in [0, 1). */
  next(): number {
    let [a, b, c, d] = this.state;
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    this.state = [a, b, c, d];
    return (t >>> 0) / 4294967296;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  intRange(min: number, maxInclusive: number): number {
    return min + this.int(maxInclusive - min + 1);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }

  weighted<T>(items: readonly T[], weight: (t: T) => number): T {
    let total = 0;
    for (const it of items) total += Math.max(0, weight(it));
    let r = this.next() * total;
    for (const it of items) {
      r -= Math.max(0, weight(it));
      if (r <= 0) return it;
    }
    return items[items.length - 1];
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** Stable per-key derived value, independent of the main stream. */
  static hash(...keys: number[]): number {
    let h = 2166136261;
    for (const k of keys) {
      h ^= k | 0;
      h = Math.imul(h, 16777619);
      h ^= h >>> 13;
    }
    return (h >>> 0) / 4294967296;
  }
}
