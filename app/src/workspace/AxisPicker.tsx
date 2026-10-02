import { useState } from "react";
import type { Dimension } from "../api/types";
import s from "./AxisPicker.module.css";

// Definitions render exactly as GET /dimensions returned them: they are the scorer's prompt.
export function AxisPicker({ dims, x, y, onChange }: { dims: Dimension[]; x: string; y: string; onChange: (x: string, y: string) => void }) {
  return (
    <div className={s.pickers}>
      <Axis axis="x" dims={dims} value={x} onPick={(v) => (v === y ? onChange(v, x) : onChange(v, y))} />
      <Axis axis="y" dims={dims} value={y} onPick={(v) => (v === x ? onChange(y, v) : onChange(x, v))} />
    </div>
  );
}

function Axis({ axis, dims, value, onPick }: { axis: "x" | "y"; dims: Dimension[]; value: string; onPick: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const d = dims.find((k) => k.key === value);
  return (
    <div className={s.sel}>
      <span className={s.k}>{axis.toUpperCase()}</span>
      <select className={s.select} data-testid={`axis-${axis}`} value={value} onChange={(e) => onPick(e.target.value)}>
        {dims.map((o) => (
          <option key={o.key} value={o.key}>{o.name}</option>
        ))}
      </select>
      <button type="button" className={s.info} data-testid={`axis-${axis}-info`} aria-label={`What ${d?.name ?? "this axis"} means`}
        onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
        i
      </button>
      {open && d && (
        <span role="tooltip" className={s.tip} data-testid={`axis-${axis}-definition`}>{d.definition}</span>
      )}
    </div>
  );
}
