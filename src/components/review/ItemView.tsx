import { useEffect, useRef, useState } from "react";
import { getLocale, useT } from "../../i18n";
import { namer } from "../../lib/render/names";
import { statement } from "../../lib/review/statement";
import type { Claim, KnowledgeModel, ReviewAction, ReviewAnswer, ReviewItem } from "../../types";
import { Badge, Button } from "../ui";
import { EvidenceView } from "./EvidenceView";

const NONE = "__none__";

/** Edit targets: the same kind of node as the current target (another table, topic, component or feature). */
function editChoices(c: Claim, model: KnowledgeModel): { value: string; label: string }[] | "text" | null {
  const lang = getLocale();
  const n = namer(model, lang);
  if (c.kind === "DESCRIBES") return "text";
  if (c.kind === "BELONGS_TO_FEATURE") return model.features.map((f) => ({ value: f.id, label: `${n.feature(f)} (${f.id})` }));
  if (c.subject.type !== "EDGE" || !c.payload.to) return null;
  if (c.payload.toType === "SINK") {
    const kind = n.sinkKind(c.payload.to);
    return model.catalog.sinks.filter((s) => s.kind === kind).map((s) => ({ value: s.id, label: n.sink(s.id) }));
  }
  return model.catalog.components.map((x) => ({ value: x.id, label: n.component(x.id) }));
}

export function ItemView(props: {
  item: ReviewItem;
  model: KnowledgeModel;
  answer?: ReviewAnswer;
  repoPath: string;
  onAnswer: (a: Omit<ReviewAnswer, "answeredAt" | "itemId">) => Promise<void>;
}) {
  const t = useT().review;
  const lang = getLocale();
  const { item, model } = props;
  const c = item.claim;
  const [mode, setMode] = useState<ReviewAction | null>(null);
  const [comment, setComment] = useState("");
  const [value, setValue] = useState("");
  const shownAt = useRef(Date.now());

  useEffect(() => {
    shownAt.current = Date.now();
    setMode(null);
    setComment(props.answer?.comment ?? "");
    setValue(c.kind === "DESCRIBES" ? c.payload.text ?? "" : c.payload.to ?? c.payload.feature ?? "");
  }, [item.id]);

  const choices = editChoices(c, model);
  const send = (action: ReviewAction, payload?: Record<string, string>) =>
    // Time on the item is telemetry for the "suspiciously fast" flag.
    props.onAnswer({ action, payload, comment: comment.trim() || undefined, millisSpent: Date.now() - shownAt.current }).then(() => setMode(null));

  const editPayload = (): Record<string, string> =>
    c.kind === "DESCRIBES" ? { text: value.trim() } : c.kind === "BELONGS_TO_FEATURE" ? { feature: value } : { to: value, toType: c.payload.toType ?? "SINK" };

  // A clarifying question instead of "is it right?": choosing the current target confirms, another one corrects.
  const pick = (v: string) => (v === NONE ? send("REJECT") : v === c.payload.to ? send("CONFIRM") : send("EDIT", { to: v, toType: "SINK" }));

  const n = namer(model, lang);
  const conflictText = c.conflict ? statement(c, model, lang, c.conflict) : "";

  return (
    <div className="review-item">
      <p className="statement">{item.options ? t.question : statement(c, model, lang)}</p>
      <div className="row wrap">
        <Badge>{t.origin[c.origin]}</Badge>
        <Badge tone={c.confidence === "HIGH" ? "good" : c.confidence === "MEDIUM" ? "warn" : "bad"}>{t.confidence[c.confidence]}</Badge>
        {props.answer && <Badge tone="good">{t.answered(t.actions[props.answer.action])}</Badge>}
      </div>
      {c.status === "STALE" && <p className="note warn">{t.stale((c.staleReasons ?? []).map((r) => (r === "missing" ? t.missing : r.replace(/^changed:/, ""))).join(", "))}</p>}
      {c.previousPayload && <p className="note">{t.diff(statement(c, model, lang, c.previousPayload))}</p>}
      {c.conflict && <p className="note warn">{t.conflict(conflictText)}</p>}

      {c.evidence.length === 0 && <p className="note warn">{t.noEvidence}</p>}
      {c.evidence.map((e, i) => <EvidenceView key={i} evidence={e} repoPath={props.repoPath} />)}

      {item.options ? (
        <div className="options">
          {item.options.map((o) => <Button key={o} onClick={() => pick(o)}>{n.sink(o)}</Button>)}
          <Button variant="ghost" onClick={() => pick(NONE)}>{t.noneOfThem}</Button>
        </div>
      ) : (
        <div className="row wrap actions">
          <Button variant="primary" onClick={() => send("CONFIRM")}>{t.actions.CONFIRM}</Button>
          <Button disabled={!choices} onClick={() => setMode("EDIT")}>{t.actions.EDIT}</Button>
          <Button onClick={() => send("REJECT")}>{t.actions.REJECT}</Button>
          <Button variant="ghost" title={t.dontKnowTip} onClick={() => setMode("DONT_KNOW")}>{t.actions.DONT_KNOW}</Button>
        </div>
      )}

      {mode === "EDIT" && choices && (
        <div className="edit">
          {choices === "text" ? (
            <label className="field"><span className="field-label">{t.editText}</span><textarea rows={3} value={value} onChange={(e) => setValue(e.target.value)} /></label>
          ) : (
            <label className="field">
              <span className="field-label">{t.editTarget}</span>
              <select value={value} onChange={(e) => setValue(e.target.value)}>
                {choices.map((ch) => <option key={ch.value} value={ch.value}>{ch.label}</option>)}
              </select>
            </label>
          )}
        </div>
      )}
      {(mode === "EDIT" || mode === "DONT_KNOW") && (
        <>
          <label className="field"><span className="field-label">{t.comment}</span><input value={comment} onChange={(e) => setComment(e.target.value)} /></label>
          <Button variant="primary" disabled={mode === "EDIT" && !value.trim()} onClick={() => send(mode, mode === "EDIT" ? editPayload() : undefined)}>{t.save}</Button>
        </>
      )}
    </div>
  );
}
