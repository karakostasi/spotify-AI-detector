/** Linear interpolation of x through sorted [x, y] points, clamped at the ends. */
export function piecewise(x: number, points: [number, number][]): number {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    const [x0, y0] = points[i - 1]!;
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return last[1];
}

export const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const squash = (s: string) => normalizeName(s).replace(/ /g, "");

/** Channels that are the artist's own (including "NinaLaneVEVO" and auto-generated "- Topic" channels). */
export function isOwnChannel(channelTitle: string, artist: string): boolean {
  const c = squash(channelTitle);
  return c.includes(squash(artist)) || /\btopic$/.test(normalizeName(channelTitle)) || c.endsWith("vevo");
}

/** "PT1H2M3S" -> 3723 */
export function parseIsoDuration(d: string | undefined): number | undefined {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d ?? "");
  if (!m || !d || d === "P" || d === "PT") return undefined;
  const [, days, h, min, sec] = m.map((x) => Number(x ?? 0));
  return (days ?? 0) * 86400 + (h ?? 0) * 3600 + (min ?? 0) * 60 + (sec ?? 0);
}
