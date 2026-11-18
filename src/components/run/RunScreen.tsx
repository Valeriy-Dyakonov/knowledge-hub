import { useCallback, useEffect, useRef, useState } from "react";
import { api, backend } from "../../api";
import { getLocale, useT } from "../../i18n";
import { constructs, parseReport } from "../../lib/parseReport";
import { resumeRun, runAnalysis } from "../../lib/pipeline";
import { STAGES } from "../../lib/stages";
import type { LogEntry, RepoEntry, RunRecord, Settings } from "../../types";
import { Badge, Button, Card, Switch, Title } from "../ui";
import { activityText, clock, logText } from "./logText";
import { showRun, startRun, useRunView } from "./runStore";

const tone = (s: RunRecord["status"]) => (s === "COMPLETED" ? "good" : s === "FAILED" ? "bad" : "warn");
type StageState = "done" | "current" | "failed" | "skipped" | "pending";

const DETAIL_KEY = "hub.run.details";
const readDetails = () => { try { return localStorage.getItem(DETAIL_KEY) !== "0"; } catch { return true; } };

/** Seconds since `since`, updated every second while shown. */
function useElapsed(since?: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  return since ? Math.max(0, Math.round((now - since) / 1000)) : 0;
}

export default function RunScreen(props: { repo: RepoEntry; settings: Settings }) {
  const t = useT().run;
  const { repo, settings } = props;
  const llmReady = !!settings.llmBaseUrl && !!settings.llmModel;
  const [describe, setDescribe] = useState(llmReady);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [details, setDetails] = useState(readDetails);
  // The run state lives in a store: the analysis goes on, with its log and progress, when this screen is left.
  const view = useRunView(repo.serviceId);
  const { busy, log, current, error } = view;
  const a = view.activity;
  const elapsed = useElapsed(busy ? a?.since : undefined);

  const refresh = useCallback(() => api.listRuns(repo.serviceId).then(setRuns).catch(() => setRuns([])), [repo.serviceId]);
  useEffect(() => { refresh(); }, [refresh, busy]);

  const start = () => startRun(repo.serviceId, (h) => runAnalysis(
    {
      serviceId: repo.serviceId, serviceName: repo.name, repoPath: repo.path, language: getLocale(),
      describe: describe && llmReady,
      llm: { requestsPerMinute: settings.llmRequestsPerMinute, maxRequests: settings.llmMaxRequests },
    },
    { backend },
    h,
  ), refresh);
  const resume = (r: RunRecord) => startRun(repo.serviceId, (h) => resumeRun(r, { backend }, h), refresh);
  const open = async (r: RunRecord) => showRun(repo.serviceId, r, await api.runLogs(repo.serviceId, r.id).catch(() => []));
  const toggleDetails = (v: boolean) => {
    setDetails(v);
    try { localStorage.setItem(DETAIL_KEY, v ? "1" : "0"); } catch { /* remembered until restart */ }
  };

  const stageState = (id: string): StageState => {
    if (current?.completedStages.includes(id)) {
      return log.some((e) => e.code === "stepSkipped" && e.params?.kind === "stage" && e.params?.id === id) ? "skipped" : "done";
    }
    if (busy && view.stage === id) return "current";
    if (!busy && current?.status === "FAILED" && current.completedStages.length === STAGES.findIndex((s) => s.id === id)) return "failed";
    return "pending";
  };

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
                <span className="act-text">{a ? activityText(a) : view.stage ? t.stages[view.stage] ?? view.stage : t.idle}</span>
                <span className="hint nw">{a?.total ? `${a.current ?? 0} / ${a.total}` : ""}{a?.since ? ` · ${t.elapsed(elapsed)}` : ""}</span>
                {a?.total ? <div className="meter"><i style={{ width: `${Math.min(100, ((a.current ?? 0) / a.total) * 100)}%` }} /></div> : null}
                {(a?.code === "llmRequest" || a?.code === "llmWaiting") && (
                  <LiveText text={view.stream} waiting={a.code === "llmRequest" && !view.stream} />
                )}
              </div>
            )}
          </>
        )}
        {error && <p className="error">{error}</p>}
      </Card>

      <ParseProblems log={log} run={current} />

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
              <button className="linkbtn" disabled={busy} onClick={() => open(r)}>{new Date(r.startedAt).toLocaleString(getLocale())}</button>
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

/** What the LLM is writing right now, as it streams in (the JSON with names and descriptions). */
function LiveText(props: { text: string; waiting: boolean }) {
  const t = useT().run;
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [props.text]);
  return (
    <div className="live">
      <div className="hint">{props.waiting ? t.llmThinking : t.llmWriting}</div>
      <pre ref={ref}>{props.text || "…"}{props.waiting ? "" : <span className="caret-blink">▍</span>}</pre>
    </div>
  );
}

/** Constructs the grammar could not parse, shown anonymised; the report for a chat carries no file names or code. */
function ParseProblems(props: { log: LogEntry[]; run: RunRecord | null }) {
  const t = useT().run;
  const [copied, setCopied] = useState(false);
  const problems = props.log
    .filter((e) => e.code === "parseError" && e.params?.file)
    .map((e) => ({ file: e.params!.file, detail: e.params!.detail ?? "", context: e.params!.context, pattern: e.params!.pattern, unparsed: e.params!.unparsed, first: e.params!.first === "true" }));
  if (!problems.length) return null;
  const list = constructs(problems);
  const copy = async () => {
    await navigator.clipboard.writeText(parseReport(problems, { extractor: "kotlin-spring", version: props.run?.versions["extractor.kotlin-spring"] }));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <Card>
      <div className="row wrap">
        <h3 className="warn-title">{t.parseProblems(list.length)}</h3>
        <span className="spacer" />
        <Button variant="primary" onClick={copy}>{copied ? t.copied : t.copyReport}</Button>
      </div>
      <p className="muted">{t.parseProblemsText}</p>
      {list.map((c, i) => (
        <div key={i} className="construct">
          <b>{t.constructTitle(i + 1, c.files.length, c.count)}</b> <span className={c.first ? "badge warn" : "badge"}>{c.first ? t.parseReport.firstShort : t.parseReport.consequenceShort}</span>
          <div className="hint">{t.context}: <code>{c.context || "?"}</code></div>
          <pre className="mmd-src">{c.pattern || "?"}</pre>
          <details className="help">
            <summary>{t.where}</summary>
            <ul className="plain">{c.files.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
          </details>
        </div>
      ))}
    </Card>
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
