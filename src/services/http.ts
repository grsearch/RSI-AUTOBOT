export async function fetchJson<T>(
  url: string | URL,
  init: RequestInit = {},
  options: { timeoutMs?: number; retries?: number } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retries = options.retries ?? 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 500);
        const error = new Error(`HTTP ${response.status}: ${body}`);
        if (response.status < 500 && response.status !== 429) throw error;
        lastError = error;
      } else {
        return (await response.json()) as T;
      }
    } catch (error) {
      lastError = error;
      if (error instanceof Error && /^HTTP 4(?!29)/.test(error.message)) throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < retries) await delay(250 * 2 ** attempt);
  }
  throw lastError instanceof Error ? lastError : new Error("HTTP request failed");
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
