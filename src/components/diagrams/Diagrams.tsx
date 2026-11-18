import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { getLocale, useT } from "../../i18n";
import { componentsDiagram, contextDiagram, featureMapDiagram } from "../../lib/render/mermaid";
import { namer } from "../../lib/render/names";
import { interactions } from "../../lib/render/overview";
import type { KnowledgeModel, RepoEntry } from "../../types";
import { Card, Segmented, Title } from "../ui";
import { Diagram } from "./Diagram";

type Level = "context" | "features" | "components";
const LEVEL_KEY = "hub.diagrams.level";
const readLevel = (): Level => {
  try { const v = localStorage.getItem(LEVEL_KEY); return v === "features" || v === "components" ? v : "context"; } catch { return "context"; }
};

/** L1 context, L2 feature map and the technical component view, with the same text in words next to them. */
export default function Diagrams(props: { repo: RepoEntry }) {
  const t = useT().diagrams;
  const [model, setModel] = useState<KnowledgeModel | null | undefined>(undefined);
  const [level, setLevel] = useState<Level>(readLevel);

  useEffect(() => {
    api.loadModel(props.repo.serviceId).then(setModel).catch(() => setModel(null));
  }, [props.repo.serviceId]);

  const lang = getLocale();
  const text = useMemo(() => {
    if (!model) return "";
    return level === "context" ? contextDiagram(model, lang) : level === "features" ? featureMapDiagram(model, lang) : componentsDiagram(model, lang);
  }, [model, level, lang]);
  const choose = (l: Level) => {
    setLevel(l);
    try { localStorage.setItem(LEVEL_KEY, l); } catch { /* remembered until restart */ }
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
        {model && <Diagram text={text} />}
        {model && <Legend />}
      </Card>
      {model && <Interactions model={model} />}
      {model && <Areas model={model} />}
    </>
  );
}

function Legend() {
  const t = useT().diagrams.legend;
  return (
    <div className="legend-row">
      {(["trigger", "feature", "component", "db", "queue", "external"] as const).map((k) => (
        <span key={k} className={`lg-item lg-${k}`}><i />{t[k]}</span>
      ))}
      <span className="lg-item lg-dashed"><i />{t.inferred}</span>
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
function Areas({ model }: { model: KnowledgeModel }) {
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
                  <b>{n.feature(f)}</b>
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
