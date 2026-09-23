export interface GlyphReference { char: string; vector: number[] }
export type GlyphMatch = { state: 'exact'; char: string; score: number } | { state: 'unresolved' };

/** Reference-vector glyph matching; ambiguous candidates stay unresolved (Y05 intent). */
export function matchGlyph(vector: number[], references: GlyphReference[]): GlyphMatch {
  let best: { char: string; score: number } | null = null;
  let runnerUp = -1;
  for (const reference of references) {
    const score = cosine(vector, reference.vector);
    if (score === null) continue;
    if (best === null || score > best.score) {
      if (best !== null && best.char !== reference.char) runnerUp = Math.max(runnerUp, best.score);
      best = { char: reference.char, score };
    } else if (best.char !== reference.char) runnerUp = Math.max(runnerUp, score);
  }
  if (best === null || best.score < 0.95 || best.score - runnerUp < 0.01) return { state: 'unresolved' };
  return { state: 'exact', char: best.char, score: best.score };
}

function cosine(a: number[], b: number[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return null;
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  if (na === 0 || nb === 0) return null;
  return dot / Math.sqrt(na * nb);
}

export function checkRenderBudget(input: { pages: number; pixels: number; deadlineAtMs: number; nowMs: number }): boolean {
  if (input.pages > 500) throw new Error(`pages exceed budget: ${input.pages} > 500`);
  if (input.pixels > 100_000_000) throw new Error(`pixels exceed budget: ${input.pixels} > 100000000`);
  if (input.deadlineAtMs <= input.nowMs) throw new Error('render deadline already passed');
  return true;
}
