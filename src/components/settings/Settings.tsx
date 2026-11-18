import { useEffect, useState, type ComponentType } from "react";
import { api } from "../../api";
import { useT } from "../../i18n";
import { readTheme, themeText, useTheme } from "../../theme";
import { reviewerOf, type GitUser, type Settings as S } from "../../types";
import { Button } from "../ui";
import { AppearanceSection, KnowledgeSection, LLM_SECRET, LlmSection, McpSection, ReviewSection, type SectionProps } from "./sections";

type SectionId = "knowledge" | "llm" | "review" | "mcp" | "appearance";
interface SectionStatus { ok: boolean; sub: string; required?: boolean }

interface Section {
  id: SectionId;
  status: (p: SectionProps) => SectionStatus;
  Component: ComponentType<SectionProps>;
}

/** Side menu and content of the settings page, in display order; a new section is a component plus an entry here. */
function sections(t: ReturnType<typeof useT>["settings"]): Section[] {
  return [
    { id: "knowledge", status: (p) => ({ ok: true, sub: p.form.knowledgeDir || p.knowledgeDir }), Component: KnowledgeSection },
    {
      id: "llm",
      status: (p) => {
        const ok = !!p.form.llmBaseUrl.trim() && !!p.form.llmModel.trim();
        return { ok, sub: ok ? `${p.form.llmModel} · ≤${p.form.llmRequestsPerMinute}/min` : `${t.status.optional} · ${t.status.llmOff}` };
      },
      Component: LlmSection,
    },
    {
      id: "review",
      status: (p) => {
        const name = reviewerOf(p.form, p.git);
        return { ok: !!name, required: !name, sub: name ? t.status.reviewer(name, t.policies[p.form.reviewPolicy] ?? p.form.reviewPolicy) : t.status.noReviewer };
      },
      Component: ReviewSection,
    },
    { id: "mcp", status: () => ({ ok: true, sub: t.status.mcp }), Component: McpSection },
    { id: "appearance", status: () => ({ ok: true, sub: themeText(readTheme()).label }), Component: AppearanceSection },
  ];
}

export default function Settings(props: { settings: S; git: GitUser; onSave: (s: S) => Promise<void> }) {
  const { settings: t, common } = useT();
  useTheme(); // the appearance status follows the theme
  const [form, setForm] = useState<S>(props.settings);
  const [active, setActive] = useState<SectionId>("knowledge");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [knowledgeDir, setKnowledgeDir] = useState("");
  const [keyStored, setKeyStored] = useState(false);

  const refreshKey = () => api.secretsStatus().then((s) => setKeyStored(!!s[LLM_SECRET])).catch(() => {});
  useEffect(() => { setForm(props.settings); }, [props.settings]);
  useEffect(() => {
    api.knowledgeDir().then(setKnowledgeDir).catch(() => {});
    refreshKey();
  }, []);

  const dirty = JSON.stringify(form) !== JSON.stringify(props.settings);
  const save = async () => {
    try {
      await props.onSave(form);
      setStatus({ ok: true, text: common.saved });
      api.knowledgeDir().then(setKnowledgeDir).catch(() => {});
    } catch (e) {
      setStatus({ ok: false, text: String(e) });
    }
  };
  const sectionProps: SectionProps = {
    form,
    set: (patch) => { setForm((f) => ({ ...f, ...patch })); setStatus(null); },
    git: props.git,
    knowledgeDir,
    keyStored,
    onKeyChanged: refreshKey,
  };
  const list = sections(t);

  return (
    <div className="settings-layout">
      <nav className="settings-nav">
        {list.map((sec) => {
          const st = sec.status(sectionProps);
          const mark = st.ok ? "ok" : st.required ? "req" : "off";
          return (
            <button key={sec.id} className={`sideitem ${active === sec.id ? "active" : ""}`} onClick={() => setActive(sec.id)}>
              <span className={`mark ${mark}`}>{st.ok ? "✓" : st.required ? "!" : "○"}</span>
              <span className="lbl">{t.nav[sec.id]}<small>{st.sub}</small></span>
            </button>
          );
        })}
        <p className="side-note">{t.readOnlyNote}</p>
        <div className="side-note secure">
          <svg viewBox="0 0 16 16"><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>
          <span>{t.secure.before}<b>{t.secure.store}</b>{t.secure.after}</span>
        </div>
      </nav>
      <div className="settings-main">
        {list.map(({ id, Component }) => (
          <div key={id} hidden={active !== id}><Component {...sectionProps} /></div>
        ))}
        <div className="savebar">
          <Button variant="primary" onClick={save} disabled={!dirty}>{common.save}</Button>
          {dirty && <span className="status">{t.unsaved}</span>}
          {status && <span className={`status ${status.ok ? "ok" : "err"}`}>{status.text}</span>}
        </div>
      </div>
    </div>
  );
}
