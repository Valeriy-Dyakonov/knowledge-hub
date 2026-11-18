import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, backend } from "../../api";
import { getLocale, useT } from "../../i18n";
import { constructs, parseReport } from "../../lib/parseReport";
import { describeRun, resumeRun, runAnalysis } from "../../lib/pipeline";
import { STAGES, type RunState } from "../../lib/stages";
import { runMode, type LogEntry, type RepoEntry, type RunRecord, type Settings } from "../../types";
import { Badge, Button, Card, Switch, Title } from "../ui";
import { activityText, clock, logText } from "./logText";
import { startRun, useRunView, type RunView } from "./runStore";

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

const when = (iso: string) => new Date(iso).toLocaleString(getLocale(), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const duration = (r: RunRecord) => (r.finishedAt ? Math.max(0, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000)) : undefined);

/**
 * Analysis of a repository: its runs on the left, the selected run on the right (stages, result, journal).
 * A static run reads code and configuration; an LLM run adds business names to the result of a finished static run.
 */
export default function RunScreen(props: { repo: RepoEntry; settings: Settings }) {
  const t = useT().run;
  const { repo, settings } = props;
  const llmReady = !!settings.llmBaseUrl && !!settings.llmModel;
  const llm = { requestsPerMinute: settings.llmRequestsPerMinute, maxRequests: settings.llmMaxRequests };
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thenLlm, setThenLlm] = useState(false);
  const [headCommit, setHeadCommit] = useState<string | null>(null);
  // The live run lives in a store: the analysis goes on, with its log and progress, when this screen is left.
  const view = useRunView(repo.serviceId);
  const { busy } = view;

  const refresh = useCallback(() => api.listRuns(repo.serviceId).then(setRuns).catch(() => setRuns([])), [repo.serviceId]);
  useEffect(() => { setSelectedId(null); }, [repo.serviceId]);
  useEffect(() => { refresh(); }, [refresh, busy, view.current?.status]);
  useEffect(() => { api.inspectRepo(repo.path).then((r) => setHeadCommit(r.commit), () => setHeadCommit(null)); }, [repo.path, busy]);
  // A starting run is shown at once.
  useEffect(() => { if (busy && view.current) setSelectedId(view.current.id); }, [busy, view.current?.id]);

  const list = useMemo(() => {
    // The live record is fresher than the saved list while it runs.
    const live = view.current;
    const merged = live ? [live, ...runs.filter((r) => r.id !== live.id)] : runs;
    return merged.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }, [runs, view.current]);
  const selected = list.find((r) => r.id === selectedId) ?? list[0] ?? null;
  // The LLM describes the newest finished static result.
  const base = list.find((r) => r.status === "COMPLETED" && runMode(r) !== "llm") ?? null;

  const startStatic = () => startRun(repo.serviceId, async (h) => {
    const options = { serviceId: repo.serviceId, serviceName: repo.name, repoPath: repo.path, language: getLocale(), describe: false, mode: "static" as const, llm };
    const done = await runAnalysis(options, { backend }, h);
    return thenLlm && llmReady ? describeRun(done, { language: getLocale(), llm }, { backend }, h) : done;
  }, refresh);
  const startLlm = (from: RunRecord) => startRun(repo.serviceId, (h) => describeRun(from, { language: getLocale(), llm }, { backend }, h), refresh);
  const resume = (r: RunRecord) => startRun(repo.serviceId, (h) => resumeRun(r, { backend }, h), refresh);

  return (
    <>
      <Card>
        <div className="row wrap">
          <Title tip={t.modesTip} wide>{t.title}: {repo.name}</Title>
          <span className="spacer" />
          <Switch checked={thenLlm && llmReady} onChange={setThenLlm} title={llmReady ? t.thenLlmTip : t.reasons.llmNotConfigured}>{t.thenLlm}</Switch>
          <Button variant="primary" disabled={busy} onClick={startStatic} title={t.staticTip}>{t.startStatic}</Button>
          <Button disabled={busy || !llmReady || !base} onClick={() => base && startLlm(base)}
            title={!llmReady ? t.reasons.llmNotConfigured : base ? t.llmTip(when(base.startedAt), base.commit.slice(0, 7)) : t.llmNeedsStatic}>
            {t.startLlm}
          </Button>
        </div>
        {busy && <p className="hint"><span className="spin dark" /> {t.running}</p>}
        {!busy && base && headCommit && headCommit !== "unknown" && headCommit !== base.commit && <p className="hint warn-text">{t.codeChanged(base.commit.slice(0, 7), headCommit.slice(0, 7))}</p>}
      </Card>

      {list.length === 0 ? <Card><p className="muted">{t.noRuns}</p></Card> : (
        <div className="features">
          <Card className="fl-list">
            <div className="fl-group-name">{t.history} <span className="count">{list.length}</span></div>
            {list.map((r) => (
              <button key={r.id} className={`fl-item ${r.id === selected?.id ? "on" : ""}`} onClick={() => setSelectedId(r.id)}>
                <span className="fl-name">
                  {when(r.startedAt)} <span className={`mode-tag ${runMode(r)}`}>{t.modes[runMode(r)]}</span>
                </span>
                {r.status === "RUNNING" && busy && view.current?.id === r.id ? <span className="spin dark" /> : <span className={`dot ${tone(r.status)}`} title={t.status[r.status]} />}
                <span className="hint">
                  {r.commit.slice(0, 7)}{r.branch ? ` · ${r.branch}` : ""}
                  {r.basedOn ? ` · ${t.basedOnShort(when(list.find((x) => x.id === r.basedOn)?.startedAt ?? r.startedAt))}` : ""}
                  {r.status === "RUNNING" && !(busy && view.current?.id === r.id) ? ` · ${t.interrupted}` : ""}
                </span>
              </button>
            ))}
          </Card>
          <div className="fl-detail">
            {selected && (
              <RunDetail
                key={selected.id}
                run={selected}
                live={view.current?.id === selected.id ? view : null}
                runs={list}
                canDescribe={llmReady && !busy}
                busy={busy}
                onSelect={setSelectedId}
                onResume={resume}
                onDescribe={startLlm}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}

function RunDetail(props: {
  run: RunRecord; live: RunView | null; runs: RunRecord[]; canDescribe: boolean; busy: boolean;
  onSelect: (id: string) => void; onResume: (r: RunRecord) => void; onDescribe: (r: RunRecord) => void;
}) {
  const { run, live } = props;
  const t = useT().run;
  const [saved, setSaved] = useState<LogEntry[]>([]);
  const [details, setDetails] = useState(readDetails);
  const running = !!live?.busy;
  // A finished run shows its saved journal; the live one shows the journal as it grows.
  useEffect(() => {
    if (running) return;
    api.runLogs(run.options.serviceId, run.id).then(setSaved, () => setSaved([]));
  }, [run.id, run.status, running]);
  const log = running ? live!.log : saved.length || !live ? saved : live.log;
  const a = running ? live!.activity : null;
  const elapsed = useElapsed(running ? a?.since : undefined);
  const mode = runMode(run);
  const base = run.basedOn ? props.runs.find((r) => r.id === run.basedOn) : undefined;
  const secs = duration(run);
  const toggleDetails = (v: boolean) => {
    setDetails(v);
    try { localStorage.setItem(DETAIL_KEY, v ? "1" : "0"); } catch { /* remembered until restart */ }
  };

  const stageState = (id: string): StageState => {
    if (mode === "llm" && run.basedOn && ["scan", "discover", "trace"].includes(id)) return "skipped";
    if (run.completedStages.includes(id)) {
      return log.some((e) => e.code === "stepSkipped" && e.params?.kind === "stage" && e.params?.id === id) ? "skipped" : "done";
    }
    if (running && live!.stage === id) return "current";
    if (run.status === "FAILED" && run.completedStages.length === STAGES.findIndex((s) => s.id === id)) return "failed";
    return "pending";
  };
  const shown = details ? log : log.filter((e) => e.level !== "detail");

  return (
    <>
      <Card>
        <div className="row wrap">
          <h3 className="fv-title">{t.runTitle(when(run.startedAt))}</h3>
          <span className={`mode-tag ${mode}`}>{t.modes[mode]}</span>
          <Badge tone={tone(run.status)}>{running ? t.status.RUNNING : run.status === "RUNNING" ? t.interrupted : t.status[run.status]}</Badge>
          <span className="spacer" />
          {run.status !== "COMPLETED" && !running && (
            <Button size="small" disabled={props.busy} title={t.resumeTip} onClick={() => props.onResume(run)}>{t.resume}</Button>
          )}
          {run.status === "COMPLETED" && mode !== "llm" && (
            <Button size="small" disabled={!props.canDescribe} title={props.canDescribe ? t.describeThisTip : t.reasons.llmNotConfigured} onClick={() => props.onDescribe(run)}>{t.describeThis}</Button>
          )}
        </div>
        <p className="hint">
          {t.commitLine(run.commit.slice(0, 7), run.branch)}
          {secs !== undefined && ` · ${t.took(secs)}`}
          {base && <> · {t.basedOn} <button className="linkbtn" onClick={() => props.onSelect(base.id)}>{when(base.startedAt)}</button></>}
        </p>
        <p className="muted">{t.modeText[mode]}</p>
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
        {running && (
          <div className="activity">
            <span className="muted">{t.now}:</span>
            <span className="act-text">{a ? activityText(a) : live!.stage ? t.stages[live!.stage] ?? live!.stage : t.idle}</span>
            <span className="hint nw">{a?.total ? `${a.current ?? 0} / ${a.total}` : ""}{a?.since ? ` · ${t.elapsed(elapsed)}` : ""}</span>
            {a?.total ? <div className="meter"><i style={{ width: `${Math.min(100, ((a.current ?? 0) / a.total) * 100)}%` }} /></div> : null}
            {(a?.code === "llmRequest" || a?.code === "llmWaiting") && <LiveText text={live!.stream} waiting={a.code === "llmRequest" && !live!.stream} />}
          </div>
        )}
        {run.error && !running && <p className="error">{logText({ at: "", level: "error", code: run.error.code, params: run.error.params as Record<string, string> | undefined })}</p>}
        {live?.error && !running && !run.error && <p className="error">{live.error}</p>}
      </Card>

      {run.status === "COMPLETED" && !running && <RunResult run={run} log={log} />}

      <ParseProblems log={log} run={run} />

      {log.length > 0 && (
        <Card>
          <div className="row">
            <Title tip={t.logTip}>{t.log}</Title>
            <span className="spacer" />
            <Switch checked={details} onChange={toggleDetails}>{t.details}</Switch>
          </div>
          <Journal entries={shown} follow={running} />
        </Card>
      )}
    </>
  );
}

/** What the run produced, from its saved checkpoint: counts, and for an LLM run the names it got. */
function RunResult(props: { run: RunRecord; log: LogEntry[] }) {
  const t = useT().run;
  const [state, setState] = useState<RunState | null | undefined>(undefined);
  useEffect(() => {
    api.loadCheckpoint(props.run.options.serviceId, props.run.id).then((s) => setState((s as RunState) ?? null), () => setState(null));
  }, [props.run.id]);
  if (!state) return null;
  const m = state.model;
  const unverified = m ? m.features.reduce((n, f) => n + f.claims.filter((c) => c.status === "PROPOSED").length, 0) : 0;
  const parseErrors = state.scan?.facts.unresolved.filter((u) => u.reason === "PARSE_ERROR").length ?? 0;
  const warnings = props.log.filter((e) => e.level === "warn").length;
  const names = Object.entries(state.descriptions?.features ?? {});
  const items: [string, number | undefined][] = [
    [t.result.features, m?.features.length ?? state.traced?.length],
    [t.result.components, m?.catalog.components.length ?? state.catalogComponents?.length],
    [t.result.sinks, m?.catalog.sinks.length ?? state.catalogSinks?.length],
    [t.result.tables, m?.database?.tables.length],
    [t.result.properties, m?.config?.properties.length],
    [t.result.unverified, m ? unverified : undefined],
    [t.result.parseErrors, state.scan ? parseErrors : undefined],
    [t.result.warnings, warnings],
  ];
  return (
    <Card>
      <Title tip={t.resultTip}>{t.resultTitle}</Title>
      <div className="stats">
        {items.filter(([, v]) => v !== undefined).map(([label, v]) => (
          <div key={label} className={`stat ${label === t.result.warnings && v ? "warn" : ""}`}><b>{v}</b><span>{label}</span></div>
        ))}
      </div>
      {runMode(props.run) !== "static" && (
        names.length === 0 ? <p className="muted">{t.result.noNames}</p> : (
          <details className="help" open={names.length <= 12}>
            <summary>{t.result.names(names.length)}</summary>
            <ul className="plain names">
              {names.map(([id, d]) => <li key={id}><b>{d.name}</b> <span className="hint">{id}</span>{d.description && <div className="muted">{d.description}</div>}</li>)}
            </ul>
          </details>
        )
      )}
    </Card>
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
          <span className="rl-text">
            {logText(e)}
            {/* Texts exchanged with the LLM: folded, opened on demand. */}
            {e.params?.text && (
              <details className="rl-more" open={e.level === "warn"}>
                <summary>{t.textLabels[e.code] ?? t.showText}</summary>
                <pre>{e.params.text}</pre>
              </details>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
