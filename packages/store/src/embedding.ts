/**
 * Pluggable embedding provider. The default is a deterministic, dependency-free
 * character-trigram hashing embedding so recall works offline and in CI. Swap
 * in a real embedding API (e.g. Voyage) via this interface without touching
 * the store.
 */
export interface EmbeddingProvider {
  readonly dim: number;
  embed(text: string): number[];
}

export class HashEmbedding implements EmbeddingProvider {
  readonly dim: number;

  constructor(dim = 128) {
    this.dim = dim;
  }

  embed(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    const norm = text.toLowerCase().replace(/\s+/g, " ").trim();
    // word unigrams + char trigrams, FNV-1a hashed into buckets
    const tokens: string[] = norm.split(" ").filter(Boolean);
    for (let i = 0; i + 2 < norm.length; i++) tokens.push(norm.slice(i, i + 3));
    for (const tok of tokens) {
      let h = 0x811c9dc5;
      for (let i = 0; i < tok.length; i++) {
        h ^= tok.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      v[h % this.dim] += 1;
    }
    const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / len);
  }
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot; // inputs are L2-normalized
}
