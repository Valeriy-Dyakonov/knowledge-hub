import { useState } from "react";
import { getLocale, useT } from "../../i18n";
import { activeEdges, namer } from "../../lib/render/names";
import type { EdgeKind, Feature, KnowledgeModel, SinkKind } from "../../types";

const ORDER: SinkKind[] = ["DB_TABLE", "TOPIC", "QUEUE", "EXTERNAL_HTTP", "FILE"];

/**
 * The feature map as a table: rows are features grouped by area (collapsible), columns are the systems grouped by
 * kind, a cell says what the feature does with the system. Readable at any size, unlike a long thin diagram.
 */
export function FeatureMatrix(props: { model: KnowledgeModel; onOpenFeature: (id: string) => void }) {
  const t = useT().diagrams;
  const { model } = props;
  const n = namer(model, getLocale());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // feature -> sink -> actions
  const cells = new Map<string, Map<string, Set<EdgeKind>>>();
  const sinks = new Set<string>();
  for (const f of model.features) {
    const row = new Map<string, Set<EdgeKind>>();
    for (const e of activeEdges(f)) {
      const sink = e.to.type === "SINK" ? e.to.id : e.kind === "CONSUME" ? e.from.id : null;
      if (!sink) continue;
      sinks.add(sink);
      row.set(sink, (row.get(sink) ?? new Set()).add(e.kind));
    }
    cells.set(f.id, row);
  }
  const columns = [...sinks].sort((a, b) => ORDER.indexOf(n.sinkKind(a) as SinkKind) - ORDER.indexOf(n.sinkKind(b) as SinkKind) || n.sink(a).localeCompare(n.sink(b)));
  const kindSpans = ORDER.map((k) => ({ kind: k, count: columns.filter((c) => n.sinkKind(c) === k).length })).filter((x) => x.count);
  const areas = [...new Set(model.features.map((f) => f.group))].sort();
  const toggle = (a: string) => setCollapsed((s) => {
    const next = new Set(s);
    if (next.has(a)) next.delete(a);
    else next.add(a);
    return next;
  });

  return (
    <div className="matrix-wrap">
      <table className="matrix">
        <thead>
          <tr>
            <th className="sticky" rowSpan={2}>{t.cols.feature}</th>
            {kindSpans.map((k) => <th key={k.kind} colSpan={k.count} className={`kind-head k-${k.kind}`}>{t.kinds[k.kind]}</th>)}
          </tr>
          <tr>
            {columns.map((c) => <th key={c} className="col-head" title={c}><span>{n.sink(c)}</span></th>)}
          </tr>
        </thead>
        <tbody>
          {areas.map((a) => {
            const fs = model.features.filter((f) => f.group === a);
            const closed = collapsed.has(a);
            return [
              <tr key={`area:${a}`} className="area-row" onClick={() => toggle(a)}>
                <td className="sticky" colSpan={1}>{closed ? "▸" : "▾"} {a} <span className="count">{fs.length}</span></td>
                {columns.map((c) => {
                  const any = fs.some((f) => cells.get(f.id)?.has(c));
                  return <td key={c} className="cell">{closed && any ? <span className="dotmark" /> : null}</td>;
                })}
              </tr>,
              ...(closed ? [] : fs.map((f: Feature) => (
                <tr key={f.id}>
                  <td className="sticky">
                    <button className="linkbtn" onClick={() => props.onOpenFeature(f.id)}>{n.feature(f)}</button>
                    <span className="hint"> {t.triggerShort[f.triggers[0]?.type ?? "HTTP"]}</span>
                  </td>
                  {columns.map((c) => (
                    <td key={c} className="cell">
                      {[...(cells.get(f.id)?.get(c) ?? [])].map((k) => <span key={k} className={`act act-${k}`} title={t.actions[k]}>{t.actionShort[k]}</span>)}
                    </td>
                  ))}
                </tr>
              ))),
            ];
          })}
        </tbody>
      </table>
      <p className="hint">{Object.entries(t.actionShort).map(([k, v]) => `${v} — ${t.actions[k]}`).join(" · ")}</p>
    </div>
  );
}
