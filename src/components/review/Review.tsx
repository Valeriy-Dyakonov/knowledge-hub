import { useCallback, useEffect, useMemo, useState } from "react";
import { api, reviewBackend } from "../../api";
import { getLocale, useT } from "../../i18n";
import { needsHuman, policyById } from "../../lib/review/policy";
import { ReviewService, type CloseResult } from "../../lib/review/service";
import { statement } from "../../lib/review/statement";
import { SUMMARY_ITEM, type KnowledgeModel, type RepoEntry, type ReviewQuestion, type Settings, type StoredBatch } from "../../types";
import { Badge, Button, Card, Title } from "../ui";
import { ItemView } from "./ItemView";

export default function Review(props: { repo: RepoEntry; settings: Settings; reviewer: string }) {
  const { review: t, settings: st } = useT();
  const { repo, settings, reviewer } = props;
  const [model, setModel] = useState<KnowledgeModel | null | undefined>(undefined);
  const [stored, setStored] = useState<StoredBatch | null>(null);
  const [index, setIndex] = useState(0);
  const [result, setResult] = useState<CloseResult | null>(null);
  const [questions, setQuestions] = useState<ReviewQuestion[]>([]);
  const [error, setError] = useState("");

  const service = useMemo(
    () => new ReviewService({ backend: reviewBackend, serviceId: repo.serviceId, policy: policyById(settings.reviewPolicy), reviewer, language: getLocale() }),
    [repo.serviceId, settings.reviewPolicy, reviewer],
  );

  const reload = useCallback(async () => {
    setModel(await api.loadModel(repo.serviceId).catch(() => null));
    setQuestions(await api.reviewQuestions(repo.serviceId).catch(() => []));
    const open = await api.openBatches(repo.serviceId).catch(() => []);
    setStored(open.find((b) => b.batch.reviewer === reviewer) ?? null);
  }, [repo.serviceId, reviewer]);

  useEffect(() => { reload(); setResult(null); setIndex(0); }, [reload]);

  const run = async (f: () => Promise<void>) => {
    setError("");
    try { await f(); } catch (e) { setError(String(e)); }
  };

  const take = () => run(async () => {
    setResult(null);
    const s = await service.next();
    setStored(s);
    setIndex(0);
    if (!s) await reload();
  });

  const refreshBatch = async (id: string) => setStored(await api.findBatch(repo.serviceId, id));

  const close = () => run(async () => {
    const r = await service.close(stored!.batch.id);
    setResult(r);
    if (r.accepted || r.reasonCode === "controlFailed") {
      setStored(null);
      await reload();
    }
  });

  if (!reviewer) return <Card><Title>{t.title}</Title><p className="muted">{t.noReviewer}</p></Card>;
  if (model === undefined) return null;
  if (model === null) return <Card><Title>{t.title}</Title><p className="muted">{t.noModel}</p></Card>;

  const lang = getLocale();
  const pending = [...model.catalog.claims, ...model.features.flatMap((f) => f.claims)].filter((c) => c.status === "PROPOSED" || c.status === "STALE" || c.conflict);
  const human = pending.filter(needsHuman).length;

  return (
    <>
      <Card>
        <div className="row wrap">
          <Title tip={t.tip}>{t.title}</Title>
          <span className="hint">{t.reviewerIs(reviewer)} · {t.policy(st.policies[settings.reviewPolicy] ?? settings.reviewPolicy)}</span>
          <span className="spacer" />
          {!stored && pending.length > 0 && <Button variant="primary" onClick={take}>{t.take}</Button>}
        </div>
        <p className="muted">{pending.length ? t.queue(human, pending.length - human) : t.nothing}</p>
        {result && <ResultView result={result} model={model} />}
        {error && <p className="error">{error}</p>}
      </Card>

      {stored && stored.batch.kind === "STATIC_SUMMARY" && (
        <SummaryView stored={stored} model={model} onAnswer={(count, confirm) => run(async () => {
          await service.answer(stored.batch.id, { itemId: SUMMARY_ITEM, action: confirm ? "CONFIRM" : "DONT_KNOW", acknowledgedCount: count, answeredAt: new Date().toISOString() });
          await refreshBatch(stored.batch.id);
        })} onClose={close} />
      )}

      {stored && stored.batch.kind === "REGULAR" && (() => {
        const items = stored.batch.items;
        const item = items[Math.min(index, items.length - 1)];
        const answers = new Map(stored.answers.map((a) => [a.itemId, a]));
        const done = items.filter((i) => answers.has(i.id)).length;
        return (
          <Card>
            <div className="row wrap">
              <span className="muted">{t.progress(done, items.length)}</span>
              <div className="meter grow"><i style={{ width: `${(done / items.length) * 100}%` }} /></div>
              <Button size="small" disabled={index === 0} onClick={() => setIndex(index - 1)}>{t.prev}</Button>
              <Button size="small" disabled={index >= items.length - 1} onClick={() => setIndex(index + 1)}>{t.next}</Button>
            </div>
            <ItemView
              key={item.id}
              item={item}
              model={model}
              answer={answers.get(item.id)}
              repoPath={repo.path}
              onAnswer={(a) => run(async () => {
                await service.answer(stored.batch.id, { ...a, itemId: item.id, answeredAt: new Date().toISOString() });
                await refreshBatch(stored.batch.id);
                const nextOpen = items.findIndex((i, k) => k > index && !answers.has(i.id));
                if (nextOpen >= 0) setIndex(nextOpen);
                else if (index < items.length - 1) setIndex(index + 1);
              })}
            />
            <div className="row">
              <span className="spacer" />
              <Button variant="primary" disabled={done < items.length} title={t.closeTip} onClick={close}>{t.close}</Button>
            </div>
          </Card>
        );
      })()}

      <Card>
        <h3>{t.questions}</h3>
        {questions.length === 0 ? <p className="muted">{t.noQuestions}</p> : (
          <ul className="plain">
            {questions.map((q) => {
              const claim = [...model.catalog.claims, ...model.features.flatMap((f) => f.claims)].find((c) => c.id === q.claimId);
              return (
                <li key={q.id}>
                  {claim ? statement(claim, model, lang) : q.claimId}
                  {q.comment && <span className="muted"> — {q.comment}</span>}
                  <span className="hint"> · {t.askedBy(q.askedBy, q.owner)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}

function SummaryView(props: { stored: StoredBatch; model: KnowledgeModel; onAnswer: (count: number | undefined, confirm: boolean) => void; onClose: () => void }) {
  const t = useT().review;
  const { batch, answers } = props.stored;
  const s = batch.summary!;
  const [count, setCount] = useState("");
  const lang = getLocale();
  const answered = answers.find((a) => a.itemId === SUMMARY_ITEM);
  const claims = new Map(batch.items.map((i) => [i.claim.id, i.claim]));
  return (
    <Card>
      <h3>{t.summaryTitle}</h3>
      <p>{t.summaryText(s.count, s.files)}</p>
      <ul className="plain">
        {Object.entries(s.byKind).map(([k, n]) => <li key={k}><code>{k}</code> — {n}</li>)}
      </ul>
      <h4>{t.summaryExamples}</h4>
      <ul className="plain">
        {s.examples.map((id) => claims.get(id)).filter(Boolean).map((c) => <li key={c!.id}>{statement(c!, props.model, lang)}</li>)}
      </ul>
      <label className="field">
        <span className="field-label">{t.summaryCount}</span>
        <input inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ""))} />
      </label>
      <div className="row">
        <Button variant="primary" disabled={!count} onClick={() => props.onAnswer(Number(count), true)}>{t.summaryConfirm}</Button>
        <Button variant="ghost" onClick={() => props.onAnswer(undefined, false)}>{t.summaryLater}</Button>
        {answered && <Badge tone="good">{t.answered(t.actions[answered.action])}</Badge>}
        <span className="spacer" />
        <Button variant="primary" disabled={!answered} onClick={props.onClose}>{t.close}</Button>
      </div>
    </Card>
  );
}

function ResultView({ result, model }: { result: CloseResult; model: KnowledgeModel }) {
  const t = useT().review;
  const lang = getLocale();
  const lines: string[] = [];
  if (result.accepted) lines.push(t.result.closed);
  else if (result.reasonCode === "controlFailed") {
    lines.push(t.result.controlFailed);
    for (const c of result.controls ?? []) lines.push(t.result.controlWas(statement(c.shown, model, lang)));
  } else if (result.reasonCode === "batchIncomplete") lines.push(t.result.batchIncomplete(result.params ?? {}));
  else if (result.reasonCode === "summaryNotAcknowledged") lines.push(t.result.summaryNotAcknowledged);
  for (const f of result.flags) if (f === "tooFast" || f === "allConfirmed") lines.push(t.result[f]);
  return <div className={`note ${result.accepted ? "" : "warn"}`}>{lines.map((l, i) => <p key={i}>{l}</p>)}</div>;
}
