import { memo } from "react";
import type { Dimension, Point, Step, StepStatus } from "../api/types";
import { pairKey, splitPairKey, type PolygonMap, type ScoreIndex } from "../lib/approval";
import { BoundaryCanvas } from "./BoundaryCanvas";
import { Icon } from "./Glyph";

export const Counts = memo(function Counts({ approved, pending, removed }: { approved: number; pending: number; removed: number }) {
  return (
    <div className="counts" data-testid="counts">
      <span className="count c-approved" data-testid="count-approved">
        {Icon.checkCircle(11)} {approved} approved
      </span>
      <span className="count c-pending" data-testid="count-pending">
        {Icon.clock(11)} {pending} pending
      </span>
      {removed > 0 && (
        <span className="count c-removed" data-testid="count-removed">
          {Icon.minusCircle(11)} {removed} removed
        </span>
      )}
    </div>
  );
});

interface Props {
  dims: Dimension[];
  steps: Step[];
  idx: ScoreIndex;
  xKey: string;
  yKey: string;
  setAxes: (x: string, y: string) => void;
  polygons: PolygonMap;
  status: Record<string, StepStatus>;
  counts: { approved: number; pending: number; removed: number };
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onPolygonChange: (poly: Point[] | null, final: boolean) => void;
}

export function OversightPanel(p: Props) {
  const xDim = p.dims.find((d) => d.key === p.xKey) ?? p.dims[0];
  const yDim = p.dims.find((d) => d.key === p.yKey) ?? p.dims[1];
  const current = p.polygons[pairKey(xDim.key, yDim.key)] ?? null;
  const others = Object.entries(p.polygons).filter(([k, v]) => v.length >= 3 && k !== pairKey(xDim.key, yDim.key));
  const anyPolygon = !!current || others.length > 0;
  const nameOf = (k: string) => p.dims.find((d) => d.key === k)?.name ?? k;

  return (
    <section className="oversight" aria-label="Sketch Oversight">
      <h2 className="panel-title">Sketch Oversight</h2>
      <Counts {...p.counts} />
      {/* Always laid out (hidden, not removed) so the canvas never shifts mid-gesture. */}
      <div className="sub muted" style={{ visibility: anyPolygon ? "hidden" : "visible" }} aria-hidden={anyPolygon}>
        Draw around actions you are comfortable approving.
      </div>
      <div className="sub muted" data-testid="viewing-through">
        Viewing through: {xDim.name} × {yDim.name}
      </div>
      {others.length > 0 && (
        <div className="sub other-views" title={others.map(([k]) => splitPairKey(k).map(nameOf).join(" × ")).join("\n")}>
          Also approving through {others.length} boundary{others.length > 1 ? " sets" : ""} on other axes (
          {others.map(([k]) => splitPairKey(k).map(nameOf).join(" × ")).join("; ")})
        </div>
      )}

      <div className="section-label">Review axes</div>
      <div className="axes">
        <AxisSelect label="X-axis:" testid="x-axis" dims={p.dims} value={xDim.key} onChange={(k) => p.setAxes(k, yDim.key)} />
        <AxisSelect label="Y-axis:" testid="y-axis" dims={p.dims} value={yDim.key} onChange={(k) => p.setAxes(xDim.key, k)} />
      </div>

      <div className="instruction-row">
        <span className="instruction">Draw boundary · drag handles to reshape · double-click edge to add handle</span>
        <button className="btn btn-small" data-testid="clear-boundary" disabled={!current} onClick={() => p.onPolygonChange(null, true)}>
          Clear
        </button>
      </div>

      <div className="plot-card">
        <BoundaryCanvas
          steps={p.steps}
          idx={p.idx}
          xDim={xDim}
          yDim={yDim}
          polygon={current}
          status={p.status}
          selectedId={p.selectedId}
          onSelect={p.onSelect}
          onPolygonChange={p.onPolygonChange}
        />
      </div>

      <div className="legend">
        <span>
          <i className="dot" style={{ background: "var(--approved)" }} /> Approved
        </span>
        <span>
          <i className="dot" style={{ background: "var(--pending)" }} /> Pending approval
        </span>
        <span>
          <i className="dot" style={{ background: "var(--removed)" }} /> Removed
        </span>
      </div>
    </section>
  );
}

function AxisSelect({
  label,
  dims,
  value,
  onChange,
  testid,
}: {
  label: string;
  dims: Dimension[];
  value: string;
  onChange: (k: string) => void;
  testid: string;
}) {
  const d = dims.find((x) => x.key === value);
  return (
    <div className="axis-col">
      <label className="axis-row">
        <span className="axis-label">{label}</span>
        <span className="select-wrap">
          <select data-testid={testid} value={value} onChange={(e) => onChange(e.target.value)} title={d?.definition}>
            {dims.map((x) => (
              <option key={x.key} value={x.key} title={x.definition}>
                {x.name}
              </option>
            ))}
          </select>
          <svg className="select-chevrons" width="9" height="12" viewBox="0 0 9 12" aria-hidden>
            <path d="M1.5 4.5 4.5 1.5 7.5 4.5M1.5 7.5 4.5 10.5 7.5 7.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </label>
      {/* Byte-identical to the string the scorer was prompted with (GET /dimensions). */}
      <div className="axis-def" data-testid={`${testid}-definition`}>
        {d?.definition}
      </div>
    </div>
  );
}
