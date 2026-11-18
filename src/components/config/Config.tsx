import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { useT } from "../../i18n";
import { simpleName } from "../../lib/model/ids";
import { componentFeatures } from "../../lib/model/usage";
import type { ConfigProperty, Evidence, KnowledgeModel, RepoEntry } from "../../types";
import { featureName } from "../features/Features";
import { Badge, Card, Segmented, Title } from "../ui";

const loc = (e?: Evidence) => (e ? `${e.path}${e.lines ? `:${e.lines.start}` : ""}` : "");

type Filter = "all" | "used" | "unused" | "missing";
const FILTERS: Filter[] = ["all", "used", "unused", "missing"];
const matches = (p: ConfigProperty, f: Filter) =>
  f === "all" || (f === "used" && p.usages.length > 0) || (f === "unused" && p.usages.length === 0) || (f === "missing" && p.missing);
/** Group by the first segment, or the first two for the crowded `spring.*`. */
const groupOf = (key: string) => {
  const parts = key.split(".");
  return parts[0] === "spring" && parts.length > 2 ? parts.slice(0, 2).join(".") : parts[0];
};

export default function Config(props: { repo: RepoEntry; onOpenFeature: (id: string) => void }) {
  const t = useT().config;
  const [model, setModel] = useState<KnowledgeModel | null | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    setSelected(null);
    api.loadModel(props.repo.serviceId).then(setModel).catch(() => setModel(null));
  }, [props.repo.serviceId]);

  const cfg = model?.config;
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const m = new Map<string, ConfigProperty[]>();
    for (const p of cfg?.properties ?? []) {
      if (!matches(p, filter)) continue;
      if (q && !`${p.key} ${p.value ?? ""} ${Object.values(p.profiles).join(" ")} ${p.usages.map((u) => u.componentId).join(" ")}`.toLowerCase().includes(q)) continue;
      m.set(groupOf(p.key), [...(m.get(groupOf(p.key)) ?? []), p]);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [cfg, query, filter]);

  if (model === undefined) return null;
  if (!model || !cfg) return <Card><Title>{t.title}</Title><p className="muted">{model ? t.reanalyse : t.empty}</p></Card>;
  if (!cfg.properties.length) return <Card><Title>{t.title}</Title><p className="muted">{t.none}</p></Card>;
  const prop = cfg.properties.find((p) => p.key === selected);
  const missing = cfg.properties.filter((p) => p.missing).length;
  const toggle = (g: string) => {
    const next = new Set(collapsed);
    if (next.has(g)) next.delete(g);
    else next.add(g);
    setCollapsed(next);
  };

  return (
    <div className="features">
      <Card className="fl-list">
        <input className="fl-search" placeholder={t.search} value={query} onChange={(e) => setQuery(e.target.value)} />
        <Segmented<Filter> size="small" title={t.filterTip} options={FILTERS.map((f) => ({ value: f, label: t.filters[f] }))} value={filter} onChange={setFilter} />
        {cfg.profiles.length > 0 && <p className="hint">{t.profiles}: {cfg.profiles.join(", ")}</p>}
        {missing > 0 && <p className="hint warn-text">{t.missingCount(missing)}</p>}
        {groups.length === 0 && <p className="muted">{t.noHits}</p>}
        {groups.map(([group, items]) => (
          <div key={group} className="fl-group">
            <button className="fl-group-name" onClick={() => toggle(group)} aria-expanded={!collapsed.has(group)}>
              <span className="caret">{collapsed.has(group) && !query ? "▸" : "▾"}</span>{group} <span className="count">{items.length}</span>
            </button>
            {(!collapsed.has(group) || !!query) && items.map((p) => (
              <button key={p.key} className={`fl-item ${p.key === selected ? "on" : ""}`} onClick={() => setSelected(p.key)}>
                <span className="fl-name">{p.key.slice(group.length + 1) || p.key}</span>
                <span className={`dot ${p.missing ? "bad" : p.usages.length ? "good" : ""}`} title={p.missing ? t.missing : p.usages.length ? t.used : t.unusedHint} />
                <span className="hint">{p.secret ? t.secretValue : p.value ?? Object.values(p.profiles)[0] ?? (p.usages.find((u) => u.default !== undefined)?.default ? t.defaultIs(p.usages.find((u) => u.default !== undefined)!.default!) : "—")}</span>
              </button>
            ))}
          </div>
        ))}
      </Card>
      <div className="fl-detail">
        {prop ? <PropertyView prop={prop} model={model} onOpenFeature={props.onOpenFeature} /> : <Card><p className="muted">{t.select}</p></Card>}
      </div>
    </div>
  );
}

function PropertyView({ prop: p, model, onOpenFeature }: { prop: ConfigProperty; model: KnowledgeModel; onOpenFeature: (id: string) => void }) {
  const t = useT().config;
  const profiles = model.config!.profiles;
  const features = [...new Map(p.usages.flatMap((u) => componentFeatures(model, u.componentId)).map((f) => [f.id, f])).values()];
  return (
    <>
      <Card>
        <div className="row wrap">
          <h3 className="fv-title"><code>{p.key}</code></h3>
          {p.missing && <Badge tone="bad">{t.missing}</Badge>}
          {p.secret && <Badge tone="warn">{t.secret}</Badge>}
        </div>
        {p.source && <p className="hint">{t.definedIn}: {p.source}</p>}
        {p.missing && <p className="muted">{t.missingHint}</p>}
      </Card>
      <Card>
        <Title tip={t.valuesTip}>{t.values}</Title>
        <table className="grid">
          <tbody>
            <tr><th>{t.base}</th><td>{p.value !== undefined ? <code>{p.value}</code> : <span className="hint">—</span>}</td></tr>
            {profiles.map((pr) => (
              <tr key={pr}><th>{pr}</th><td>{p.profiles[pr] !== undefined ? <code>{p.profiles[pr]}</code> : <span className="hint">{t.inherits}</span>}</td></tr>
            ))}
            {p.usages.filter((u) => u.default !== undefined).map((u, i) => (
              <tr key={`d${i}`}><th>{t.codeDefault}</th><td><code>{u.default}</code> <span className="hint">{simpleName(u.componentId)}</span></td></tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card>
        <Title tip={t.readersTip}>{t.readers}</Title>
        {p.usages.length === 0 ? <p className="muted">{t.unusedHint}</p> : (
          <ul className="plain">
            {p.usages.map((u, i) => (
              <li key={i}>
                <Badge>{t.kinds[u.kind] ?? u.kind}</Badge> <code>{simpleName(u.componentId)}{u.method ? `.${u.method}` : ""}</code>
                {u.viaPrefix && <span className="hint"> {t.viaPrefix(u.viaPrefix)}</span>}
                <span className="hint flow-loc"> {loc(u.evidence)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <Title tip={t.featuresTip}>{t.features}</Title>
        {features.length === 0 ? <p className="muted">{t.noFeatures}</p> : (
          <ul className="plain">
            {features.map((f) => (
              <li key={f.id}><button className="linkbtn" onClick={() => onOpenFeature(f.id)}>{featureName(f)}</button> <span className="hint">{f.technicalName}</span></li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
