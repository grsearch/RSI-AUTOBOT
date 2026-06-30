import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

export function useApi<T>(path: string, intervalMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try { setData(await api<T>(path)); setError(null); }
    catch (nextError) { setError(nextError); }
    finally { setLoading(false); }
  }, [path]);
  useEffect(() => {
    void refresh();
    if (!intervalMs) return;
    const timer = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [refresh, intervalMs]);
  return { data, error, loading, refresh };
}
