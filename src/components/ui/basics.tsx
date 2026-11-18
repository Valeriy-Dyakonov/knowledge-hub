import type { ReactNode } from "react";
import { useT } from "../../i18n";

export function Field(props: { label: string; hint?: string; tip?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{props.label}{props.tip && <InfoTip>{props.tip}</InfoTip>}</span>
      {props.children}
      {props.hint && <span className="hint">{props.hint}</span>}
    </label>
  );
}

/** Small "i" badge that shows an explanation on hover or keyboard focus. */
export function InfoTip(props: { children: ReactNode; wide?: boolean }) {
  const t = useT().common;
  return (
    <span className={`infotip ${props.wide ? "wide" : ""}`} tabIndex={0} aria-label={t.help}>
      <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.5" /><path d="M8 7.2v4M8 4.8v.1" /></svg>
      <span className="tip" role="tooltip">{props.children}</span>
    </span>
  );
}

export function Help(props: { title: string; steps: ReactNode[]; note?: ReactNode }) {
  return (
    <details className="help">
      <summary>{props.title}</summary>
      <ol>
        {props.steps.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
      {props.note && <p className="note">{props.note}</p>}
    </details>
  );
}

export function Title(props: { children: ReactNode; tip?: ReactNode; wide?: boolean; as?: "h3" | "h4" }) {
  const H = props.as ?? "h3";
  return <H className="titled">{props.children}{props.tip && <InfoTip wide={props.wide}>{props.tip}</InfoTip>}</H>;
}
