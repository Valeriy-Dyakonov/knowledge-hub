import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../api";
import { LOCALES, setLocale, useLocale, useT, type Locale } from "../../i18n";
import { setTheme, THEMES, themeText, useTheme, type ThemeId } from "../../theme";
import type { Settings as S } from "../../types";
import { Button, Card, Field, Segmented } from "../ui";

export const LLM_SECRET = "llm_key";

interface SectionProps { form: S; set: (patch: Partial<S>) => void }

/** Settings sections in display order; a new section is a component plus an entry here. */
const SECTIONS: { id: "knowledge" | "llm" | "review" | "appearance"; Body: (p: SectionProps) => ReactNode }[] = [
  { id: "knowledge", Body: KnowledgeSection },
  { id: "llm", Body: LlmSection },
  { id: "review", Body: ReviewSection },
  { id: "appearance", Body: AppearanceSection },
];

export default function Settings(props: { settings: S; onSave: (s: S) => Promise<void> }) {
  const t = useT();
  const [form, setForm] = useState<S>(props.settings);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setForm(props.settings), [props.settings]);

  const save = async () => {
    try {
      await props.onSave(form);
      setStatus({ ok: true, text: t.common.saved });
    } catch (e) {
      setStatus({ ok: false, text: String(e) });
    }
  };

  return (
    <>
      {SECTIONS.map(({ id, Body }) => (
        <Card key={id}>
          <h3>{t.settings.sections[id]}</h3>
          <Body form={form} set={(patch) => { setForm((f) => ({ ...f, ...patch })); setStatus(null); }} />
        </Card>
      ))}
      <div className="row">
        <Button variant="primary" onClick={save}>{t.common.save}</Button>
        {status && <span className={`status ${status.ok ? "ok" : "err"}`}>{status.text}</span>}
      </div>
    </>
  );
}

function KnowledgeSection({ form, set }: SectionProps) {
  const t = useT().settings;
  const [effective, setEffective] = useState("");
  useEffect(() => { api.knowledgeDir().then(setEffective).catch(() => {}); }, []);
  const browse = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, title: t.knowledgeDir });
    if (typeof picked === "string") set({ knowledgeDir: picked });
  };
  return (
    <Field label={t.knowledgeDir} tip={t.knowledgeDirTip} hint={form.knowledgeDir ? undefined : t.knowledgeDirDefault(effective)}>
      <div className="row">
        <input value={form.knowledgeDir} placeholder={effective} onChange={(e) => set({ knowledgeDir: e.target.value })} />
        <Button onClick={browse}>{t.browse}</Button>
      </div>
    </Field>
  );
}

function LlmSection({ form, set }: SectionProps) {
  const { settings: t, common } = useT();
  const [stored, setStored] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { api.secretsStatus().then((s) => setStored(!!s[LLM_SECRET])).catch(() => {}); }, []);
  const saveKey = async () => {
    try {
      await api.setSecret(LLM_SECRET, key);
      setStored(!!key);
      setKey("");
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <>
      <Field label={t.llmUrl} hint={t.llmUrlHint}>
        <input value={form.llmBaseUrl} onChange={(e) => set({ llmBaseUrl: e.target.value })} />
      </Field>
      <Field label={t.llmModel}>
        <input value={form.llmModel} onChange={(e) => set({ llmModel: e.target.value })} />
      </Field>
      <Field label={t.llmKey} tip={t.llmKeyTip} hint={stored ? t.llmKeyStored : undefined}>
        <div className="row">
          <input type="password" value={key} placeholder={stored ? t.llmKeyPlaceholder : ""} onChange={(e) => setKey(e.target.value)} />
          <Button onClick={saveKey}>{common.save}</Button>
        </div>
      </Field>
      {error && <p className="error">{error}</p>}
    </>
  );
}

function ReviewSection({ form, set }: SectionProps) {
  const t = useT().settings;
  return (
    <>
      <Field label={t.reviewer} tip={t.reviewerTip}>
        <input value={form.reviewer} onChange={(e) => set({ reviewer: e.target.value })} />
      </Field>
      <Field label={t.reviewPolicy} tip={t.policyTip}>
        <Segmented
          options={Object.entries(t.policies).map(([value, label]) => ({ value, label }))}
          value={form.reviewPolicy}
          onChange={(v) => set({ reviewPolicy: v })}
        />
      </Field>
    </>
  );
}

function AppearanceSection(_: SectionProps) {
  const t = useT().settings;
  const locale = useLocale();
  const theme = useTheme();
  return (
    <>
      <Field label={t.language} tip={t.languageTip}>
        <Segmented<Locale> options={LOCALES.map((l) => ({ value: l.id, label: l.label }))} value={locale} onChange={setLocale} />
      </Field>
      <Field label={t.theme}>
        <Segmented<ThemeId> options={THEMES.map((x) => ({ value: x.id, label: themeText(x.id).label }))} value={theme} onChange={setTheme} />
      </Field>
    </>
  );
}
