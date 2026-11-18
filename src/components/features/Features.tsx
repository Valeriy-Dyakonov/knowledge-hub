import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { getLocale, useT } from "../../i18n";
import { isUnverified } from "../../lib/model/claims";
import { flowSteps } from "../../lib/model/flow";
import { simpleName } from "../../lib/model/ids";
import { statusOf } from "../../lib/model/status";
import { flowDiagram } from "../../lib/render/mermaid";
import { Diagram } from "../diagrams/Diagram";
import type { Evidence, Feature, KnowledgeModel, RepoEntry } from "../../types";
import { Badge, Card, Segmented, Title } from "../ui";

const tone = { REVIEWED: "good", DRAFT: "warn", STALE: "bad" } as const;

export const featureName = (f: Feature) => f.businessName[getLocale()] ?? Object.values(f.businessName)[0] ?? f.technicalName;
const loc = (e?: Evidence) => (e ? `${e.path}${e.lines ? `:${e.lines.start}` : ""}` : "");

type GroupBy = "entry" | "area" | "class";
const GROUP_KEY = "hub.features.groupBy";
const readGroupBy = (): GroupBy => {
  try { const v = localStorage.getItem(GROUP_KEY); return v === "area" || v === "class" ? v : "entry"; } catch { return "entry"; }
};
const ENTRY_ORDER = ["HTTP", "MESSAGE:kafka", "MESSAGE:rabbit", "MESSAGE:jms", "MESSAGE:sqs", "MESSAGE", "SCHEDULE", "ASYNC", "EVENT", "STARTUP", "CLI"];

/** How a feature is entered: HTTP controller, Kafka listener, scheduled job... (message triggers split by broker). */
function entryKey(f: Feature): string {
  const t = f.triggers[0];
  if (!t) return "CLI";
  return t.type === "MESSAGE" && t.attributes.broker ? `MESSAGE:${t.attributes.broker}` : t.type;
}

export default function Features(props: { repo: RepoEntry; focus?: { id: string } | null }) {
  const t = useT().features;
  const [model, setModel] = useState<KnowledgeModel | null | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [groupBy, setGroupBy] = useState<GroupBy>(readGroupBy);
  const changeGroupBy = (g: GroupBy) => {
    setGroupBy(g);
    try { localStorage.setItem(GROUP_KEY, g); } catch { /* remembered until restart */ }
  };

  useEffect(() => {
    setSelected(null);
    api.loadModel(props.repo.serviceId).then(setModel).catch(() => setModel(null));
  }, [props.repo.serviceId]);

  // Collapsed groups, remembered per grouping mode.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    try { setCollapsed(new Set(JSON.parse(localStorage.getItem(`${GROUP_KEY}.collapsed.${groupBy}`) ?? "[]"))); } catch { setCollapsed(new Set()); }
  }, [groupBy]);
  const saveCollapsed = (s: Set<string>) => {
    setCollapsed(s);
    try { localStorage.setItem(`${GROUP_KEY}.collapsed.${groupBy}`, JSON.stringify([...s])); } catch { /* remembered until restart */ }
  };
  const toggleGroup = (g: string) => {
    const next = new Set(collapsed);
    if (next.has(g)) next.delete(g);
    else next.add(g);
    saveCollapsed(next);
  };

  // Full-text search through the index (same as MCP `search`); a plain substring filter if the index is unavailable.
  const [hits, setHits] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return setHits(null);
    const timer = setTimeout(() => {
      api.search(q, props.repo.serviceId, 50).then(
        (r) => setHits(new Map(r.map((h) => [h.featureId, h.snippet]))),
        () => setHits(null),
      );
    }, 200);
    return () => clearTimeout(timer);
  }, [query, props.repo.serviceId]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (model?.features ?? []).filter((f) =>
      !q || (hits ? hits.has(f.id) : `${f.id} ${f.technicalName} ${featureName(f)}`.toLowerCase().includes(q)));
    const key = (f: Feature) => (groupBy === "entry" ? entryKey(f) : groupBy === "class" ? simpleName(f.triggers[0]?.componentId ?? f.group) : f.group);
    const m = new Map<string, Feature[]>();
    for (const f of list) m.set(key(f), [...(m.get(key(f)) ?? []), f]);
    const rank = (k: string) => (groupBy === "entry" ? ENTRY_ORDER.indexOf(k) : 0);
    return [...m.entries()]
      .map(([k, items]) => [k, [...items].sort((a, b) => a.group.localeCompare(b.group) || featureName(a).localeCompare(featureName(b)))] as [string, Feature[]])
      .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  }, [model, query, hits, groupBy]);
  const groupTitle = (k: string) => (groupBy === "entry" ? t.entryKinds[k] ?? k : k);

  // Opened from another screen: select the feature and unfold its group.
  useEffect(() => {
    if (!props.focus || !model) return;
    setSelected(props.focus.id);
    setQuery("");
    const g = groups.find(([, items]) => items.some((f) => f.id === props.focus!.id))?.[0];
    if (g && collapsed.has(g)) toggleGroup(g);
    setTimeout(() => document.querySelector(".fl-item.on")?.scrollIntoView({ block: "center" }), 50);
  }, [props.focus, model]);

  if (model === undefined) return null;
  if (model === null) return <Card><Title>{t.title}</Title><p className="muted">{t.empty}</p></Card>;
  if (!model.features.length) return <Card><Title>{t.title}</Title><p className="muted">{t.none}</p></Card>;
  const feature = model.features.find((f) => f.id === selected);

  return (
    <div className="features">
      <Card className="fl-list">
        <input className="fl-search" placeholder={t.search} value={query} onChange={(e) => setQuery(e.target.value)} />
        <Segmented<GroupBy>
          size="small"
          title={t.groupByTip}
          options={[{ value: "entry", label: t.groupBy.entry }, { value: "area", label: t.groupBy.area }, { value: "class", label: t.groupBy.class }]}
          value={groupBy}
          onChange={changeGroupBy}
        />
        <div className="row fl-tools">
          <button className="linkbtn small" onClick={() => saveCollapsed(new Set(groups.map(([g]) => g)))}>{t.collapseAll}</button>
          <button className="linkbtn small" onClick={() => saveCollapsed(new Set())}>{t.expandAll}</button>
        </div>
        {groups.length === 0 && <p className="muted">{t.noHits}</p>}
        {groups.map(([group, items]) => (
          <div key={group} className="fl-group">
            <button className="fl-group-name" onClick={() => toggleGroup(group)} aria-expanded={!collapsed.has(group)}>
              <span className="caret">{collapsed.has(group) && !query ? "▸" : "▾"}</span>{groupTitle(group)} <span className="count">{items.length}</span>
            </button>
            {(!collapsed.has(group) || !!query) && items.map((f) => {
              const s = statusOf(f.claims);
              return (
                <button key={f.id} className={`fl-item ${f.id === selected ? "on" : ""}`} onClick={() => setSelected(f.id)}>
                  <span className="fl-name">{featureName(f)}{f.edges.some((e) => e.async) && <span className="async-mark" title={t.hasAsync}> ⇢</span>}</span>
                  <span className={`dot ${tone[s]}`} title={s} />
                  <span className="hint">{hits?.get(f.id) || (groupBy === "entry" ? `${f.group} · ${f.technicalName}` : f.technicalName)}</span>
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
          {flowSteps(model, f).map((s, i) => (
            <li key={i} className={s.origin === "INFERRED" ? "inferred" : ""}>
              <b>{nodeName(s.from.id, s.from.type)}</b> <span className="muted">{t.edgeKinds[s.kind] ?? s.kind}</span> <b>{nodeName(s.to.id, s.to.type)}</b>
              <span className="muted"> · {s.label}</span>
              {s.via && <span className="muted"> · {t.via(nodeName(s.via.componentId, "COMPONENT"))}</span>}
              {s.async && <Badge>{t.async}</Badge>}
              {s.origin === "INFERRED" && <Badge tone="warn">{t.inferred}</Badge>}
              <span className="hint flow-loc">{loc(s.evidence)}</span>
            </li>
          ))}
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
