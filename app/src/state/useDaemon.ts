import { useCallback, useEffect, useMemo, useState } from "react";
import { connectDaemon, type DaemonApi } from "../api/client";
import type { Dimension, Health } from "../api/types";

export interface DaemonConn {
  api: DaemonApi | null;
  health: Health | null;
  reachable: boolean;
  dims: Dimension[];
  refreshHealth(): Promise<void>;
}

export function useDaemon(): DaemonConn {
  const [api, setApi] = useState<DaemonApi | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [reachable, setReachable] = useState(true);
  const [dims, setDims] = useState<Dimension[]>([]);

  useEffect(() => {
    let alive = true;
    void connectDaemon().then((a) => alive && setApi(a));
    return () => {
      alive = false;
    };
  }, []);

  const refreshHealth = useCallback(async () => {
    if (!api) return;
    try {
      setHealth(await api.health());
      setReachable(true);
    } catch {
      setReachable(false);
    }
  }, [api]);

  useEffect(() => {
    if (!api) return;
    void refreshHealth();
    const t = setInterval(() => void refreshHealth(), 5000);
    return () => clearInterval(t);
  }, [api, refreshHealth]);

  // Load (and after an outage, re-load) the ten dimensions.
  useEffect(() => {
    if (!api || dims.length || !reachable) return;
    api.dimensions().then(setDims, () => undefined);
  }, [api, dims.length, reachable, health]);

  return useMemo(() => ({ api, health, reachable, dims, refreshHealth }), [api, health, reachable, dims, refreshHealth]);
}
