import { useEffect, useState } from "react";
import type { DaemonApi } from "../api/client";
import type { AppSettings, Provider } from "../api/types";
import type { DaemonConn } from "../state/useDaemon";
import s from "./AppShell.module.css";

const LABEL: Record<Provider, string> = { anthropic: "Anthropic", openai: "OpenAI" };

export function ModelPicker({ api, conn }: { api: DaemonApi; conn: DaemonConn }) {
  const [st, setSt] = useState<AppSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.getSettings().then((x) => alive && setSt(x), () => undefined);
    return () => {
      alive = false;
    };
  }, [api, conn.reachable]);

  if (!st) return null;
  const change = async (value: string) => {
    const [provider, model] = value.split("::") as [Provider, string];
    try {
      setSt(await api.putSettings({ provider, model }));
      setErr(null);
      await conn.refreshHealth();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <select className={s.picker} aria-label="Model" title={err ?? "Planner and scorer model"} value={`${st.provider}::${st.model}`}
      onChange={(e) => void change(e.target.value)}>
      {(Object.keys(st.models) as Provider[]).map((p) => (
        <optgroup key={p} label={LABEL[p]}>
          {st.models[p].map((m) => (
            <option key={m} value={`${p}::${m}`}>
              {m}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
