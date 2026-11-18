import { useEffect, useState } from "react";
import { api } from "../../api";
import { useT } from "../../i18n";
import type { RepoEntry, RepoInfo, Settings } from "../../types";
import { Badge, Button, Card, Title } from "../ui";

/** Folder name -> knowledge base folder: lowercase, dashes. */
export const serviceIdOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "service";

export default function Repos(props: { settings: Settings; selected: string | null; onSelect: (path: string) => void; onSave: (s: Settings) => Promise<void> }) {
  const { repos: t, common } = useT();
  const [info, setInfo] = useState<Record<string, RepoInfo | string>>({});
  const [error, setError] = useState("");
  const repos = props.settings.repos;

  useEffect(() => {
    for (const r of repos) {
      api.inspectRepo(r.path).then(
        (i) => setInfo((m) => ({ ...m, [r.path]: i })),
        (e) => setInfo((m) => ({ ...m, [r.path]: String(e) })),
      );
    }
  }, [repos]);

  const add = async () => {
    setError("");
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, title: t.pickTitle });
    if (typeof picked !== "string") return;
    if (repos.some((r) => r.path === picked)) return setError(t.duplicate);
    try {
      const i = await api.inspectRepo(picked);
      const taken = new Set(repos.map((r) => r.serviceId));
      let id = serviceIdOf(i.name);
      for (let n = 2; taken.has(id); n++) id = `${serviceIdOf(i.name)}-${n}`;
      const entry: RepoEntry = { path: picked, serviceId: id, name: i.name };
      await props.onSave({ ...props.settings, repos: [...repos, entry] });
      props.onSelect(picked);
    } catch (e) {
      setError(String(e));
    }
  };

  const remove = (path: string) => props.onSave({ ...props.settings, repos: repos.filter((r) => r.path !== path) });

  return (
    <Card>
      <div className="row">
        <Title tip={t.tip}>{t.title}</Title>
        <span className="spacer" />
        <Button variant="primary" onClick={add}>{t.add}</Button>
      </div>
      {error && <p className="error">{error}</p>}
      {repos.length === 0 && <p className="muted">{t.empty}</p>}
      <ul className="repolist">
        {repos.map((r) => {
          const i = info[r.path];
          return (
            <li key={r.path} className={props.selected === r.path ? "on" : ""}>
              <div className="rl-main">
                <b>{r.name}</b>
                <span className="muted">{r.path}</span>
                {typeof i === "string" ? <span className="status err">{i}</span> : i && <span className="hint">{t.commit(i.commit, i.branch)} · {r.serviceId}</span>}
              </div>
              {props.selected === r.path ? <Badge tone="good">{t.selected}</Badge> : <Button size="small" onClick={() => props.onSelect(r.path)}>{t.select}</Button>}
              <Button size="small" variant="ghost" onClick={() => remove(r.path)}>{common.remove}</Button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
