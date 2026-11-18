import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { getLocale, useT } from "../../i18n";
import { isUnverified } from "../../lib/model/claims";
import { simpleName } from "../../lib/model/ids";
import { statusOf } from "../../lib/model/status";
import { flowDiagram } from "../../lib/render/mermaid";
import { Diagram } from "../diagrams/Diagram";
import type { Evidence, Feature, KnowledgeModel, RepoEntry } from "../../types";
import { Badge, Card, Title } from "../ui";

const tone = { REVIEWED: "good", DRAFT: "warn", STALE: "bad" } as const;

export const featureName = (f: Feature) => f.businessName[getLocale()] ?? Object.values(f.businessName)[0] ?? f.technicalName;
const loc = (e?: Evidence) => (e ? `${e.path}${e.lines ? `:${e.lines.start}` : ""}` : "");

export default function Features(props: { repo: RepoEntry }) {
  const t = useT().features;
  const [model, setModel] = useState<KnowledgeModel | null | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setSelected(null);
    api.loadModel(props.repo.serviceId).then(setModel).catch(() => setModel(null));
  }, [props.repo.serviceId]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (model?.features ?? []).filter((f) => !q || `${f.id} ${f.technicalName} ${featureName(f)}`.toLowerCase().includes(q));
    const m = new Map<string, Feature[]>();
    for (const f of list) m.set(f.group, [...(m.get(f.group) ?? []), f]);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [model, query]);

  if (model === undefined) return null;
  if (model === null) return <Card><Title>{t.title}</Title><p className="muted">{t.empty}</p></Card>;
  if (!model.features.length) return <Card><Title>{t.title}</Title><p className="muted">{t.none}</p></Card>;
  const feature = model.features.find((f) => f.id === selected);

  return (
    <div className="features">
      <Card className="fl-list">
        <input className="fl-search" placeholder={t.search} value={query} onChange={(e) => setQuery(e.target.value)} />
        {groups.map(([group, items]) => (
          <div key={group} className="fl-group">
            <div className="fl-group-name">{group}</div>
            {items.map((f) => {
              const s = statusOf(f.claims);
              return (
                <button key={f.id} className={`fl-item ${f.id === selected ? "on" : ""}`} onClick={() => setSelected(f.id)}>
                  <span className="fl-name">{featureName(f)}</span>
                  <span className={`dot ${tone[s]}`} title={s} />
                  <span className="hint">{f.technicalName}</span>
                </button>
              );
            })}
          </div>
        ))}
      </Card>
      <div className="fl-detail">
        {feature ? <FeatureView feature={feature} model={model} /> : <Card><p className="muted">{t.select}</p></Card>}
      </div>
    </div>
  );
}

function FeatureView({ feature: f, model }: { feature: Feature; model: KnowledgeModel }) {
  const { features: t, common } = useT();
  const status = statusOf(f.claims);
  const unverified = f.claims.filter(isUnverified).length;
  const components = new Map(model.catalog.components.map((c) => [c.id, c]));
  const sinks = new Map(model.catalog.sinks.map((s) => [s.id, s]));
  const edges = new Map(f.edges.map((e) => [e.id, e]));
  const lang = getLocale();
  const nodeName = (id: string, type: string) => {
    if (type === "SINK") {
      const s = sinks.get(id);
      return s ? s.businessName[lang] ?? s.technicalName : id;
    }
    if (type === "TRIGGER") return f.triggers.find((x) => x.id === id)?.technicalName ?? id;
    const c = components.get(id);
    return c ? c.businessName[lang] ?? c.technicalName : simpleName(id);
  };

  return (
    <>
      <Card>
        <div className="row wrap">
          <h3 className="fv-title">{featureName(f)}</h3>
          <Badge tone={tone[status]}>{common.status[status]}</Badge>
          {unverified > 0 && <span className="hint">{t.unverified(unverified)}</span>}
        </div>
        {f.description[lang] && <p>{f.description[lang]}</p>}
        <p className="hint">{t.technical}: <code>{f.id}</code> · {t.owner}: {f.owner ?? t.noOwner}</p>
      </Card>
      <Card>
        <h3>{t.triggers}</h3>
        <ul className="plain">
          {f.triggers.map((tr) => (
            <li key={tr.id}><Badge>{t.triggerTypes[tr.type] ?? tr.type}</Badge> <code>{tr.technicalName}</code> <span className="hint">{loc(tr.evidence)}</span></li>
          ))}
        </ul>
      </Card>
      <Card>
        <Title tip={t.flowDiagramTip}>{t.flowDiagram}</Title>
        <Diagram text={flowDiagram(model, f, lang)} />
      </Card>
      <Card>
        <Title tip={t.flowTip}>{t.flow}</Title>
        <ol className="flow">
          {f.steps.map((s) => {
            const e = s.edgeId ? edges.get(s.edgeId) : undefined;
            return (
              <li key={s.order} className={e?.origin === "INFERRED" ? "inferred" : ""}>
                {e ? (
                  <>
                    <b>{nodeName(e.from.id, e.from.type)}</b> <span className="muted">{t.edgeKinds[e.kind] ?? e.kind}</span> <b>{nodeName(e.to.id, e.to.type)}</b>
                    <span className="muted"> · {s.action}</span>
                    {e.origin === "INFERRED" && <Badge tone="warn">{t.inferred}</Badge>}
                    <span className="hint flow-loc">{loc(e.evidence)}</span>
                  </>
                ) : (
                  <b>{simpleName(s.componentId)}.{s.action}</b>
                )}
              </li>
            );
          })}
        </ol>
      </Card>
      <Card>
        <h3>{t.sinks}</h3>
        <ul className="plain">
          {f.sinkIds.map((id) => {
            const s = sinks.get(id);
            return <li key={id}><Badge>{t.sinkKinds[s?.kind ?? ""] ?? s?.kind}</Badge> <b>{nodeName(id, "SINK")}</b>{s && s.businessName[lang] && <span className="hint"> {s.technicalName}</span>}</li>;
          })}
        </ul>
      </Card>
      <Card>
        <Title tip={t.breaksTip}>{t.breaks}</Title>
        {f.breaks.length === 0 ? <p className="muted">{t.noBreaks}</p> : (
          <ul className="plain">
            {f.breaks.map((b, i) => (
              <li key={i}>
                <Badge tone="warn">{t.breakReasons[b.reason] ?? b.reason}</Badge> <code>{simpleName(b.componentId)}.{b.method}</code>
                {b.detail && <span className="muted"> {b.detail}</span>} <span className="hint">{loc(b.evidence)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
