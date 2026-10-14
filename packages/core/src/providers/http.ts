export type Fetch = typeof fetch;

/** Serializes calls and enforces a minimum gap between them. */
export class Throttle {
  private last = 0;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private minGapMs: number) {}
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(async () => {
      const wait = this.last + this.minGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await fn();
      } finally {
        this.last = Date.now();
      }
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export async function getJson<T>(f: Fetch, url: string, headers?: Record<string, string>): Promise<T | null> {
  const res = await f(url, { headers: { accept: "application/json", ...headers } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return (await res.json()) as T;
}
