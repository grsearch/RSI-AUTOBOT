export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error ?? `请求失败 (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export const n = (value: unknown): number => value == null ? 0 : Number(value);

export function shortAddress(address: string): string {
  return `${address.slice(0, 5)}…${address.slice(-5)}`;
}

export function usd(value: unknown): string {
  const number = n(value);
  if (number >= 1_000_000) return `$${(number / 1_000_000).toFixed(2)}m`;
  if (number >= 1_000) return `$${(number / 1_000).toFixed(1)}k`;
  if (number > 0 && number < 0.01) return `$${number.toPrecision(4)}`;
  return `$${number.toFixed(2)}`;
}

export function pct(value: unknown): string {
  return `${n(value) >= 0 ? "+" : ""}${n(value).toFixed(2)}%`;
}

export function sol(value: unknown): string {
  return `${n(value).toFixed(4)} SOL`;
}

export function time(value: unknown): string {
  if (!value) return "—";
  return new Date(String(value)).toLocaleString("zh-CN", { hour12: false });
}
