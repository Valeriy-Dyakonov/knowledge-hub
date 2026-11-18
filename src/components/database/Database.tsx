import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { getLocale, useT } from "../../i18n";
import { tableUsage } from "../../lib/model/usage";
import { erDiagram } from "../../lib/render/reference";
import type { Evidence, KnowledgeModel, RepoEntry, TableInfo } from "../../types";
import { Diagram } from "../diagrams/Diagram";
import { featureName } from "../features/Features";
import { Badge, Card, Title } from "../ui";

const loc = (e?: Evidence) => (e ? `${e.path}${e.lines ? `:${e.lines.start}` : ""}` : "");
const tone = { migration: undefined, both: "good", entity: "warn", code: "bad" } as const;
/** Larger schemas are drawn per table only: a full ER diagram stops being readable. */
const FULL_ER_LIMIT = 25;

export default function Database(props: { repo: RepoEntry; onOpenFeature: (id: string) => void }) {
  const t = useT().database;
  const [model, setModel] = useState<KnowledgeModel | null | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setSelected(null);
    api.loadModel(props.repo.serviceId).then(setModel).catch(() => setModel(null));
  }, [props.repo.serviceId]);

  const db = model?.database;
  const tables = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (db?.tables ?? []).filter((x) => !q || x.name.includes(q) || x.columns.some((c) => c.name.includes(q)) || (x.entity ?? "").toLowerCase().includes(q));
  }, [db, query]);

  if (model === undefined) return null;
  if (!model || !db) return <Card><Title>{t.title}</Title><p className="muted">{model ? t.reanalyse : t.empty}</p></Card>;
  if (!db.tables.length && !db.datasources.length) return <Card><Title>{t.title}</Title><p className="muted">{t.none}</p></Card>;
  const table = db.tables.find((x) => x.name === selected);

  return (
    <div className="features">
      <Card className="fl-list">
        <input className="fl-search" placeholder={t.search} value={query} onChange={(e) => setQuery(e.target.value)} />
        {db.datasources.length > 0 && (
          <div className="fl-group">
            <div className="fl-group-name">{t.datasources}</div>
            {db.datasources.map((d, i) => (
              <div key={i} className="ds-item" title={d.url}>
                <Badge>{d.kind}</Badge> <span>{[d.host, d.database].filter(Boolean).join(" / ") || d.url}</span>
                {d.profile && <span className="hint"> · {t.profile(d.profile)}</span>}
              </div>
            ))}
          </div>
        )}
        <div className="fl-group">
          <button className={`fl-group-name ${selected === null ? "on" : ""}`} onClick={() => setSelected(null)}>
            {t.tables} <span className="count">{db.tables.length}</span>
          </button>
          {tables.length === 0 && <p className="muted">{t.noHits}</p>}
          {tables.map((x) => (
            <button key={x.name} className={`fl-item ${x.name === selected ? "on" : ""}`} onClick={() => setSelected(x.name)}>
              <span className="fl-name">{x.name}</span>
              <span className={`dot ${tone[x.source] ?? ""}`} title={t.sources[x.source]} />
              <span className="hint">{x.columns.length ? t.columnCount(x.columns.length) : t.sources[x.source]}{x.entity ? ` · ${x.entity.split(".").pop()}` : ""}</span>
            </button>
          ))}
        </div>
      </Card>
      <div className="fl-detail">
        {table ? <TableView table={table} model={model} onSelect={setSelected} onOpenFeature={props.onOpenFeature} /> : (
          <Card>
            <Title tip={t.schemaTip}>{t.schema}</Title>
            {db.tables.length > FULL_ER_LIMIT ? <p className="muted">{t.tooLarge(db.tables.length)}</p> : db.tables.length ? (
              <ErView model={model} onSelect={setSelected} />
            ) : <p className="muted">{t.noTables}</p>}
          </Card>
        )}
      </div>
    </div>
  );
}

function ErView(props: { model: KnowledgeModel; focus?: string; onSelect: (name: string) => void }) {
  const spec = erDiagram(props.model.database!, getLocale(), props.focus);
  return <Diagram text={spec.text} nodes={spec.nodes} onNode={props.onSelect} />;
}

function TableView({ table, model, onSelect, onOpenFeature }: { table: TableInfo; model: KnowledgeModel; onSelect: (n: string) => void; onOpenFeature: (id: string) => void }) {
  const t = useT().database;
  const uses = tableUsage(model, table.name);
  const referencedBy = model.database!.tables.flatMap((x) => x.columns.filter((c) => c.references?.table === table.name).map((c) => ({ table: x.name, column: c.name })));
  return (
    <>
      <Card>
        <div className="row wrap">
          <h3 className="fv-title">{table.name}</h3>
          <Badge tone={tone[table.source]}>{t.sources[table.source]}</Badge>
        </div>
        {table.entity && <p className="hint">{t.entity}: <code>{table.entity}</code></p>}
        {table.evidence && <p className="hint">{loc(table.evidence)}</p>}
        {table.source === "code" && <p className="muted">{t.codeOnly}</p>}
      </Card>
      {table.columns.length > 0 && (
        <Card>
          <Title tip={t.columnsTip}>{t.columns}</Title>
          <table className="grid">
            <thead><tr><th>{t.column}</th><th>{t.type}</th><th>{t.keys}</th><th>{t.field}</th></tr></thead>
            <tbody>
              {table.columns.map((c) => (
                <tr key={c.name}>
                  <td><code>{c.name}</code></td>
                  <td>{c.dataType}</td>
                  <td>
                    {c.primaryKey && <Badge tone="good">PK</Badge>}{" "}
                    {c.references && <button className="linkbtn" onClick={() => onSelect(c.references!.table)}>FK → {c.references.table}.{c.references.column}</button>}{" "}
                    {!c.nullable && !c.primaryKey && <span className="hint">NOT NULL</span>}
                  </td>
                  <td>{c.field ? <code>{c.field}</code> : <span className="hint">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {referencedBy.length > 0 && (
            <p className="hint">{t.referencedBy}: {referencedBy.map((r, i) => (
              <span key={i}>{i > 0 && ", "}<button className="linkbtn" onClick={() => onSelect(r.table)}>{r.table}.{r.column}</button></span>
            ))}</p>
          )}
        </Card>
      )}
      <Card>
        <Title tip={t.usedByTip}>{t.usedBy}</Title>
        {uses.length === 0 ? <p className="muted">{t.unused}</p> : (
          <ul className="plain">
            {uses.map((u) => (
              <li key={u.feature.id}>
                {u.reads && <Badge>{t.reads}</Badge>} {u.writes && <Badge tone="warn">{t.writes}</Badge>}{" "}
                <button className="linkbtn" onClick={() => onOpenFeature(u.feature.id)}>{featureName(u.feature)}</button>
                <span className="hint"> {u.feature.technicalName}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {table.columns.length > 0 && (
        <Card>
          <Title tip={t.relationsTip}>{t.relations}</Title>
          <ErView model={model} focus={table.name} onSelect={onSelect} />
        </Card>
      )}
    </>
  );
}
