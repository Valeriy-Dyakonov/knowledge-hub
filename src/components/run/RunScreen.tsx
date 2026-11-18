import { useCallback, useEffect, useRef, useState } from "react";
import { api, backend } from "../../api";
import { getLocale, useT } from "../../i18n";
import { resumeRun, runAnalysis } from "../../lib/pipeline";
import { STAGES, type Activity } from "../../lib/stages";
import type { LogEntry, RepoEntry, RunRecord, Settings } from "../../types";
import { Badge, Button, Card, Switch, Title } from "../ui";
import { activityText, clock, logText } from "./logText";

const tone = (s: RunRecord["status"]) => (s === "COMPLETED" ? "good" : s === "FAILED" ? "bad" : "warn");
type StageState = "done" | "current" | "failed" | "skipped" | "pending";

const DETAIL_KEY = "hub.run.details";
const readDetails = () => { try { return localStorage.getItem(DETAIL_KEY) !== "0"; } catch { return true; } };

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
  const [activity, setActivity] = useState<{ stage?: string; activity: Activity | null }>({ activity: null });
  const [details, setDetails] = useState(readDetails);

  const refresh = useCallback(() => api.listRuns(repo.serviceId).then(setRuns).catch(() => setRuns([])), [repo.serviceId]);
  useEffect(() => { refresh(); setCurrent(null); setLog([]); }, [refresh]);

  const handlers = {
    onLog: (e: LogEntry) => setLog((l) => [...l, e]),
    onRun: setCurrent,
    onProgress: (stage: string | undefined, a: Activity | null) => setActivity({ stage, activity: a }),
  };

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
      setActivity({ activity: null });
      refresh();
    }
  };

  const start = () => go(() => runAnalysis(
    {
      serviceId: repo.serviceId, serviceName: repo.name, repoPath: repo.path, language: getLocale(),
      describe: describe && llmReady,
      llm: { requestsPerMinute: settings.llmRequestsPerMinute, maxRequests: settings.llmMaxRequests },
    },
    { backend },
    handlers,
  ));
  const resume = (r: RunRecord) => go(() => resumeRun(r, { backend }, handlers));
  const open = async (r: RunRecord) => {
    setCurrent(r);
    setLog(await api.runLogs(repo.serviceId, r.id).catch(() => []));
  };
  const toggleDetails = (v: boolean) => {
    setDetails(v);
    try { localStorage.setItem(DETAIL_KEY, v ? "1" : "0"); } catch { /* remembered until restart */ }
  };

  const stageState = (id: string): StageState => {
    if (current?.completedStages.includes(id)) {
      return log.some((e) => e.code === "stepSkipped" && e.params?.kind === "stage" && e.params?.id === id) ? "skipped" : "done";
    }
    if (busy && activity.stage === id) return "current";
    if (!busy && current?.status === "FAILED" && current.completedStages.length === STAGES.findIndex((s) => s.id === id)) return "failed";
    return "pending";
  };

  const a = activity.activity;
  const shown = details ? log : log.filter((e) => e.level !== "detail");

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
        {(busy || current) && (
          <>
            <ol className="stages">
              {STAGES.map((s) => {
                const st = stageState(s.id);
                return (
                  <li key={s.id} className={st} title={`${t.stageTips[s.id] ?? ""} — ${t.stageState[st]}`}>
                    <span className="st-mark">{st === "done" ? "✓" : st === "failed" ? "✗" : st === "skipped" ? "–" : st === "current" ? <span className="spin dark" /> : "○"}</span>
                    {t.stages[s.id] ?? s.id}
                  </li>
                );
              })}
            </ol>
            {busy && (
              <div className="activity">
                <span className="muted">{t.now}:</span>
                <span className="act-text">{a ? activityText(a) : activity.stage ? t.stages[activity.stage] ?? activity.stage : t.idle}</span>
                {a?.total ? <span className="hint nw">{a.current ?? 0} / {a.total}</span> : null}
                {a?.total ? <div className="meter"><i style={{ width: `${Math.min(100, ((a.current ?? 0) / a.total) * 100)}%` }} /></div> : null}
              </div>
            )}
          </>
        )}
        {error && <p className="error">{error}</p>}
      </Card>

      {log.length > 0 && (
        <Card>
          <div className="row">
            <Title tip={t.logTip}>{t.log}</Title>
            <span className="spacer" />
            <Switch checked={details} onChange={toggleDetails}>{t.details}</Switch>
          </div>
          <Journal entries={shown} follow={busy} />
        </Card>
      )}

      <Card>
        <h3>{t.history}</h3>
        {runs.length === 0 && <p className="muted">{t.noRuns}</p>}
        <ul className="runs">
          {runs.map((r) => (
            <li key={r.id} className={current?.id === r.id ? "on" : ""}>
              <button className="linkbtn" onClick={() => open(r)}>{new Date(r.startedAt).toLocaleString(getLocale())}</button>
              <Badge tone={tone(r.status)}>{t.status[r.status]}</Badge>
              <span className="hint">{r.commit.slice(0, 7)}</span>
              <span className="spacer" />
              {r.status === "FAILED" && <Button size="small" disabled={busy} title={t.resumeTip} onClick={() => resume(r)}>{t.resume}</Button>}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function Journal(props: { entries: LogEntry[]; follow: boolean }) {
  const t = useT().run;
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (props.follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [props.entries.length, props.follow]);
  return (
    <ol className="runlog" ref={ref}>
      {props.entries.map((e, i) => (
        <li key={i} className={e.level}>
          <span className="rl-time">{clock(e.at)}</span>
          <span className="rl-stage">{e.stage ? t.stages[e.stage] ?? e.stage : ""}</span>
          <span className="rl-text">{logText(e)}</span>
        </li>
      ))}
    </ol>
  );
}
