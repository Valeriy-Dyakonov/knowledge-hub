import { useCallback, useEffect, useState } from "react";
import { api, backend } from "../../api";
import { getLocale, useT } from "../../i18n";
import { resumeRun, runAnalysis } from "../../lib/pipeline";
import { STAGES } from "../../lib/stages";
import type { LogEntry, RepoEntry, RunRecord, Settings } from "../../types";
import { Badge, Button, Card, Switch, Title } from "../ui";
import { logText } from "./logText";

const tone = (s: RunRecord["status"]) => (s === "COMPLETED" ? "good" : s === "FAILED" ? "bad" : "warn");

export default function RunScreen(props: { repo: RepoEntry; settings: Settings }) {
  const t = useT().run;
  const { repo, settings } = props;
  const llmReady = !!settings.llmBaseUrl && !!settings.llmModel;
  const [describe, setDescribe] = useState(llmReady);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [current, setCurrent] = useState<RunRecord | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);

  const refresh = useCallback(() => api.listRuns(repo.serviceId).then(setRuns).catch(() => setRuns([])), [repo.serviceId]);
  useEffect(() => { refresh(); setCurrent(null); setLog([]); }, [refresh]);

  const handlers = { onLog: (e: LogEntry) => setLog((l) => [...l, e]), onRun: setCurrent };

  const go = async (action: () => Promise<RunRecord>) => {
    setBusy(true);
    setError("");
    setLog([]);
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const start = () => go(() => runAnalysis(
    { serviceId: repo.serviceId, serviceName: repo.name, repoPath: repo.path, language: getLocale(), describe: describe && llmReady },
    { backend },
    handlers,
  ));
  const resume = (r: RunRecord) => go(() => resumeRun(r, { backend }, handlers));
  const open = async (r: RunRecord) => {
    setCurrent(r);
    setLog(await api.runLogs(repo.serviceId, r.id).catch(() => []));
  };

  return (
    <>
      <Card>
        <div className="row wrap">
          <Title>{t.title}: {repo.name}</Title>
          <span className="spacer" />
          <Switch checked={describe && llmReady} onChange={setDescribe} title={llmReady ? t.describeTip : t.reasons.llmNotConfigured}>
            {t.describe}
          </Switch>
          <Button variant="primary" disabled={busy} onClick={start}>
            {busy ? <span className="row"><span className="spin" />{t.running}</span> : t.start}
          </Button>
        </div>
        {current && <Stages run={current} />}
        {error && <p className="error">{error}</p>}
      </Card>
      {log.length > 0 && (
        <Card>
          <h3>{t.log}</h3>
          <ol className="runlog">
            {log.map((e, i) => (
              <li key={i} className={e.level}>
                <span className="rl-stage">{e.stage ? t.stages[e.stage] ?? e.stage : ""}</span>
                <span>{logText(e)}</span>
              </li>
            ))}
          </ol>
        </Card>
      )}
      <Card>
        <h3>{t.history}</h3>
        {runs.length === 0 && <p className="muted">{t.noRuns}</p>}
        <ul className="runs">
          {runs.map((r) => (
            <li key={r.id}>
              <button className="linkbtn" onClick={() => open(r)}>{new Date(r.startedAt).toLocaleString(getLocale())}</button>
              <Badge tone={tone(r.status)}>{t.status[r.status]}</Badge>
              <span className="hint">{r.commit.slice(0, 7)}</span>
              <span className="spacer" />
              {r.status === "FAILED" && (
                <Button size="small" disabled={busy} title={t.resumeTip} onClick={() => resume(r)}>{t.resume}</Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function Stages(props: { run: RunRecord }) {
  const t = useT().run;
  const { run } = props;
  return (
    <ol className="stages">
      {STAGES.map((s) => {
        const done = run.completedStages.includes(s.id);
        const failed = !done && run.status === "FAILED" && run.completedStages.length === STAGES.findIndex((x) => x.id === s.id);
        return <li key={s.id} className={done ? "done" : failed ? "failed" : ""}>{t.stages[s.id] ?? s.id}</li>;
      })}
    </ol>
  );
}
