import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { getLocale, useT } from "../../i18n";
import { componentsDiagram, contextDiagram } from "../../lib/render/mermaid";
import type { KnowledgeModel, RepoEntry } from "../../types";
import { Card, Segmented, Title } from "../ui";
import { Diagram } from "./Diagram";

type Level = "context" | "components";

/** L1 and L2 of the service, drawn from the model with the same renderer that writes the .mmd files. */
export default function Diagrams(props: { repo: RepoEntry }) {
  const t = useT().diagrams;
  const [model, setModel] = useState<KnowledgeModel | null | undefined>(undefined);
  const [level, setLevel] = useState<Level>("context");

  useEffect(() => {
    api.loadModel(props.repo.serviceId).then(setModel).catch(() => setModel(null));
  }, [props.repo.serviceId]);

  const lang = getLocale();
  const text = useMemo(() => (model ? (level === "context" ? contextDiagram(model, lang) : componentsDiagram(model, lang)) : ""), [model, level, lang]);

  return (
    <Card>
      <div className="row wrap">
        <Title tip={level === "context" ? t.contextTip : t.componentsTip}>{t.title}</Title>
        <span className="spacer" />
        <Segmented<Level> options={[{ value: "context", label: t.context }, { value: "components", label: t.components }]} value={level} onChange={setLevel} />
      </div>
      {model === null && <p className="muted">{t.empty}</p>}
      {model && <Diagram text={text} />}
    </Card>
  );
}
