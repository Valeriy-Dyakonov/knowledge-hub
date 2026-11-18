import { useEffect, useState } from "react";
import { api } from "../../api";
import { useT } from "../../i18n";
import type { KnowledgeModel, RepoEntry } from "../../types";
import { Card, Title } from "../ui";

export default function Features(props: { repo: RepoEntry }) {
  const t = useT().features;
  const [model, setModel] = useState<KnowledgeModel | null | undefined>(undefined);

  useEffect(() => {
    api.loadModel(props.repo.serviceId).then(setModel).catch(() => setModel(null));
  }, [props.repo.serviceId]);

  return (
    <Card>
      <Title>{t.title}</Title>
      {model === null && <p className="muted">{t.empty}</p>}
      {model && model.features.length === 0 && <p className="muted">{t.notYet}</p>}
    </Card>
  );
}
