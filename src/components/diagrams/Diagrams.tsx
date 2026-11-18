import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { getLocale, useT } from "../../i18n";
import { activeEdges, namer } from "../../lib/render/names";
import { componentsDiagram, contextDiagram, featureMapDiagram } from "../../lib/render/mermaid";
import { interactions } from "../../lib/render/overview";
import type { ComponentKind, EdgeKind, Feature, KnowledgeModel, RepoEntry } from "../../types";
import { Button, Card, Segmented, Title } from "../ui";
import { Diagram } from "./Diagram";
import { FeatureMatrix } from "./FeatureMatrix";

type Level = "context" | "features" | "components";
const LEVEL_KEY = "hub.diagrams.level";
const readLevel = (): Level => {
  try { const v = localStorage.getItem(LEVEL_KEY); return v === "features" || v === "components" ? v : "context"; } catch { return "context"; }
};

/** L1 context, L2 feature map and the component view; nodes are clickable: groups expand, items show details. */
export default function Diagrams(props: { repo: RepoEntry; onOpenFeature: (id: string) => void }) {
  const t = useT().diagrams;
  const [model, setModel] = useState<KnowledgeModel | null | undefined>(undefined);
  const [level, setLevel] = useState<Level>(readLevel);
  const [expand, setExpand] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<string | null>(null);
  const [mapView, setMapView] = useState<"table" | "diagram">("table");
  // Components drill-down: all → one kind (list) → one component (its neighbourhood).
  const [kind, setKind] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);

  useEffect(() => {
    api.loadModel(props.repo.serviceId).then(setModel).catch(() => setModel(null));
  }, [props.repo.serviceId]);

  const lang = getLocale();
  const spec = useMemo(() => {
    if (!model) return null;
    if (level === "context") return contextDiagram(model, lang, { expand });
    if (level === "features") return featureMapDiagram(model, lang, { expand });
    return componentsDiagram(model, lang, { expand, focus: focus ?? undefined });
  }, [model, level, lang, expand, focus]);

  const choose = (l: Level) => {
    setLevel(l);
    setDetails(null);
    try { localStorage.setItem(LEVEL_KEY, l); } catch { /* remembered until restart */ }
  };
  const toggle = (frame: string) => setExpand((s) => {
    const next = new Set(s);
    if (next.has(frame)) next.delete(frame);
    else next.add(frame);
    return next;
  });

  const onNode = (key: string) => {
    if (key.startsWith("expand:")) return toggle(key.slice("expand:".length));
    if (key.startsWith("feature:")) return props.onOpenFeature(key.slice("feature:".length));
    if (key.startsWith("kind:")) return setKind(key.slice("kind:".length));
    if (key.startsWith("component:")) {
      setFocus(key.slice("component:".length));
      return setDetails(key);
    }
    setDetails(key);
  };

  return (
    <>
      <Card>
        <div className="row wrap">
          <Title tip={t.tips[level]} wide>{t.title}</Title>
          <span className="spacer" />
          <Segmented<Level>
            options={[{ value: "context", label: t.levels.context }, { value: "features", label: t.levels.features }, { value: "components", label: t.levels.components }]}
            value={level}
            onChange={choose}
          />
        </div>
        <p className="muted">{t.lead[level]}</p>
        {model === null && <p className="muted">{t.empty}</p>}
        {model && level === "components" && (
          <ComponentNav model={model} kind={kind} focus={focus} onKind={(k) => { setKind(k); setFocus(null); setDetails(null); }} onFocus={(c) => { setFocus(c); setDetails(c ? `component:${c}` : null); }} />
        )}
        {model && level === "features" && (
          <div className="row">
            <Segmented size="small" options={[{ value: "table", label: t.mapViews.table }, { value: "diagram", label: t.mapViews.diagram }]} value={mapView} onChange={(v) => setMapView(v as "table" | "diagram")} />
          </div>
        )}
        {model && level === "features" && mapView === "table" && <FeatureMatrix model={model} onOpenFeature={props.onOpenFeature} />}
        {model && spec && !(level === "features" && mapView === "table") && !(level === "components" && kind && !focus) && (
          <>
            <p className="hint">{t.clickHint}</p>
            <Diagram text={spec.text} nodes={spec.nodes} onNode={onNode} />
            <Legend />
          </>
        )}
        {model && level === "components" && kind && !focus && <KindList model={model} kind={kind} onFocus={(c) => { setFocus(c); setDetails(`component:${c}`); }} />}
      </Card>
      {model && details && <Details model={model} nodeKey={details} onClose={() => setDetails(null)} onOpenFeature={props.onOpenFeature} />}
      {model && level === "context" && <Interactions model={model} />}
      {model && level === "context" && <Areas model={model} onOpenFeature={props.onOpenFeature} />}
    </>
  );
}

function Legend() {
  const t = useT().diagrams.legend;
  return (
    <div className="legend-row">
      {(["trigger", "feature", "component", "db", "queue", "external", "more"] as const).map((k) => (
        <span key={k} className={`lg-item lg-${k}`}><i />{t[k]}</span>
      ))}
      <span className="lg-item lg-dashed"><i />{t.inferred}</span>
    </div>
  );
}

/** Features that use a node (table, topic, area, component), with what they do there; each opens the feature. */
function Details(props: { model: KnowledgeModel; nodeKey: string; onClose: () => void; onOpenFeature: (id: string) => void }) {
  const t = useT().diagrams;
  const { model, nodeKey } = props;
  const lang = getLocale();
  const n = namer(model, lang);
  const [type, ...rest] = nodeKey.split(":");
  const id = rest.join(":");
  let title = id;
  let rows: { feature: Feature; how: string }[] = [];
  const verbs = (f: Feature, pred: (from: string, to: string) => boolean) =>
    [...new Set(activeEdges(f).filter((e) => pred(e.from.id, e.to.id)).map((e) => t.actions[e.kind as EdgeKind] ?? e.kind))].join(", ");
  if (type === "sink") {
    title = `${t.kinds[n.sinkKind(id)] ?? ""} ${n.sink(id)}`;
    rows = model.features.map((f) => ({ feature: f, how: verbs(f, (from, to) => to === id || from === id) })).filter((r) => r.how);
  } else if (type === "topic-in") {
    title = `${t.kinds.TOPIC} ${id}`;
    rows = model.features.filter((f) => f.triggers.some((x) => x.attributes.destination === id)).map((f) => ({ feature: f, how: t.actions.CONSUME }));
  } else if (type === "area") {
    title = `${t.kinds.CLIENTS}: ${id}`;
    rows = model.features.filter((f) => f.group === id && f.triggers.some((x) => x.type === "HTTP")).map((f) => ({ feature: f, how: f.triggers.map((x) => x.technicalName).join(", ") }));
  } else if (type === "component") {
    title = n.component(id);
    rows = model.features.filter((f) => f.componentIds.includes(id)).map((f) => ({ feature: f, how: verbs(f, (from, to) => from === id || to === id) }));
  } else return null;

  return (
    <Card>
      <div className="row">
        <h3 className="nomargin">{title}</h3>
        <span className="spacer" />
        <Button size="small" variant="ghost" onClick={props.onClose}>{t.close}</Button>
      </div>
      <p className="hint">{t.usedBy(rows.length)}</p>
      <table className="grid">
        <thead><tr><th>{t.cols.feature}</th><th>{t.cols.how}</th><th /></tr></thead>
        <tbody>
          {rows.map(({ feature: f, how }) => (
            <tr key={f.id}>
              <td><b>{n.feature(f)}</b> <span className="hint">{f.id}</span></td>
              <td>{how}</td>
              <td><Button size="small" onClick={() => props.onOpenFeature(f.id)}>{t.open}</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** Breadcrumb and kind chips of the component view: All › Services › RefundService. */
function ComponentNav(props: { model: KnowledgeModel; kind: string | null; focus: string | null; onKind: (k: string | null) => void; onFocus: (c: string | null) => void }) {
  const t = useT().diagrams;
  const r = useT().render;
  const n = namer(props.model, getLocale());
  const used = new Set(props.model.features.flatMap((f) => f.componentIds));
  const kinds = [...new Set(props.model.catalog.components.filter((c) => used.has(c.id)).map((c) => c.kind))];
  const count = (k: string) => props.model.catalog.components.filter((c) => c.kind === k && used.has(c.id)).length;
  const focusKind = props.focus ? n.componentKind(props.focus) : null;
  return (
    <div className="drill">
      <div className="crumbs">
        <button className="linkbtn" onClick={() => { props.onKind(null); props.onFocus(null); }}>{t.allComponents}</button>
        {(props.kind ?? focusKind) && <><span>›</span><button className="linkbtn" onClick={() => { props.onKind(props.kind ?? focusKind); }}>{r.kinds[props.kind ?? focusKind!] ?? props.kind}</button></>}
        {props.focus && <><span>›</span><b>{n.component(props.focus)}</b></>}
      </div>
      <div className="row wrap">
        {kinds.map((k) => (
          <button key={k} className={`chip ${props.kind === k && !props.focus ? "on" : ""}`} onClick={() => props.onKind(k)}>
            {r.kinds[k as ComponentKind] ?? k} <span className="count">{count(k)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** All components of one kind, searchable; choosing one shows its neighbourhood. */
function KindList(props: { model: KnowledgeModel; kind: string; onFocus: (id: string) => void }) {
  const t = useT().diagrams;
  const n = namer(props.model, getLocale());
  const [q, setQ] = useState("");
  const used = props.model.features.flatMap((f) => f.componentIds);
  const list = props.model.catalog.components
    .filter((c) => c.kind === props.kind && used.includes(c.id))
    .map((c) => ({ c, features: props.model.features.filter((f) => f.componentIds.includes(c.id)).length }))
    .filter(({ c }) => !q || `${c.technicalName} ${n.component(c.id)} ${c.id}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b.features - a.features || a.c.technicalName.localeCompare(b.c.technicalName));
  return (
    <div className="kindlist">
      <input placeholder={t.searchComponents} value={q} onChange={(e) => setQ(e.target.value)} />
      <table className="grid">
        <thead><tr><th>{t.cols.component}</th><th>{t.cols.features}</th><th /></tr></thead>
        <tbody>
          {list.map(({ c, features }) => (
            <tr key={c.id}>
              <td><b>{n.component(c.id)}</b> <span className="hint">{c.id}</span></td>
              <td>{features}</td>
              <td><Button size="small" onClick={() => props.onFocus(c.id)}>{t.show}</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Who the service talks to, how and why — the table version of L1. */
function Interactions({ model }: { model: KnowledgeModel }) {
  const t = useT().diagrams;
  const lang = getLocale();
  const n = namer(model, lang);
  const rows = interactions(model, lang);
  return (
    <Card>
      <Title tip={t.interactionsTip}>{t.interactions}</Title>
      <table className="grid">
        <thead><tr><th>{t.cols.system}</th><th>{t.cols.how}</th><th>{t.cols.why}</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <span className={`kind-chip k-${r.kind}`}>{t.kinds[r.kind] ?? r.kind}</span> <b>{r.name}</b>
                {r.technicalName && r.technicalName !== r.name && <span className="hint"> {r.technicalName}</span>}
              </td>
              <td>{r.direction === "in" ? t.incoming[r.kind] ?? t.incoming.TOPIC : r.actions.map((a) => t.actions[a] ?? a).join(", ")}</td>
              <td>{r.features.map((f) => n.feature(f)).join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** What the service does, area by area, in business words when the LLM or a reviewer has named the features. */
function Areas({ model, onOpenFeature }: { model: KnowledgeModel; onOpenFeature: (id: string) => void }) {
  const t = useT().diagrams;
  const lang = getLocale();
  const n = namer(model, lang);
  const groups = [...new Set(model.features.map((f) => f.group))].sort();
  return (
    <Card>
      <Title tip={t.areasTip}>{t.areas}</Title>
      <div className="areas">
        {groups.map((g) => (
          <div key={g} className="area">
            <h4>{g}</h4>
            <ul className="plain">
              {model.features.filter((f) => f.group === g).map((f) => (
                <li key={f.id}>
                  <button className="linkbtn" onClick={() => onOpenFeature(f.id)}>{n.feature(f)}</button>
                  {f.description[lang] ? <span className="muted"> — {f.description[lang]}</span> : <span className="hint"> {f.technicalName}</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {!model.features.some((f) => Object.keys(f.businessName).length) && <p className="hint">{t.noNames}</p>}
    </Card>
  );
}
