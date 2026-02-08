export function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

export function mean(xs: number[]) {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}

export function std(xs: number[]) {
  const m = mean(xs);
  const v = mean(xs.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
}

export function zscore(x: number, xs: number[]) {
  const m = mean(xs);
  const s = std(xs);
  return s === 0 ? 0 : (x - m) / s;
}
