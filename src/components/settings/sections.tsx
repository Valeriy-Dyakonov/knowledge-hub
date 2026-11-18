import { useEffect, useState } from "react";
import { api } from "../../api";
import { LOCALES, setLocale, useLocale, useT, type Locale } from "../../i18n";
import { setTheme, THEMES, themeText, useTheme, type ThemeId } from "../../theme";
import type { GitUser, Settings } from "../../types";
import { Button, Card, Field, Segmented } from "../ui";

export const LLM_SECRET = "llm_key";

export interface SectionProps {
  form: Settings;
  set: (patch: Partial<Settings>) => void;
  git: GitUser;
  knowledgeDir: string;
  keyStored: boolean;
  onKeyChanged: () => void;
}

export function KnowledgeSection({ form, set, knowledgeDir }: SectionProps) {
  const t = useT().settings;
  const browse = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, title: t.knowledgeDir });
    if (typeof picked === "string") set({ knowledgeDir: picked });
  };
  return (
    <Card>
      <h3>{t.knowledge.title}</h3>
      <p className="muted">{t.knowledge.text}</p>
      <Field label={t.knowledgeDir} hint={form.knowledgeDir ? undefined : t.knowledgeDirDefault(knowledgeDir)}>
        <div className="row">
          <input value={form.knowledgeDir} placeholder={knowledgeDir} onChange={(e) => set({ knowledgeDir: e.target.value })} />
          <Button onClick={browse}>{t.browse}</Button>
        </div>
      </Field>
    </Card>
  );
}

export function LlmSection({ form, set, keyStored, onKeyChanged }: SectionProps) {
  const t = useT().settings;
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const saveKey = async (value: string) => {
    try {
      await api.setSecret(LLM_SECRET, value);
      setKey("");
      setError("");
      onKeyChanged();
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <Card>
      <h3>{t.llm.title}</h3>
      <p className="muted">{t.llm.text}</p>
      <Field label={t.llmUrl} hint={t.llmUrlHint}>
        <input value={form.llmBaseUrl} onChange={(e) => set({ llmBaseUrl: e.target.value })} />
      </Field>
      <Field label={t.llmModel}>
        <input value={form.llmModel} onChange={(e) => set({ llmModel: e.target.value })} />
      </Field>
      <div className="row wrap limits">
        <Field label={t.llmRate} tip={t.llmLimitsTip}>
          <input type="number" min={1} max={600} value={form.llmRequestsPerMinute} onChange={(e) => set({ llmRequestsPerMinute: Math.max(1, Number(e.target.value) || 1) })} />
        </Field>
        <Field label={t.llmBudget} tip={t.llmLimitsTip}>
          <input type="number" min={0} max={1000} value={form.llmMaxRequests} onChange={(e) => set({ llmMaxRequests: Math.max(0, Number(e.target.value) || 0) })} />
        </Field>
      </div>
      <Field label={t.llmKey} hint={keyStored ? t.llmKeyStored : undefined}>
        <div className="row">
          <input type="password" autoComplete="off" value={key} placeholder={keyStored ? "••••••••••" : t.llmKeyPlaceholder} onChange={(e) => setKey(e.target.value)} />
          <Button disabled={!key} onClick={() => saveKey(key)}>{t.llmKeySave}</Button>
          {keyStored && <Button variant="ghost" onClick={() => saveKey("")}>{t.llmKeyRemove}</Button>}
        </div>
      </Field>
      {error && <p className="error">{error}</p>}
    </Card>
  );
}

export function ReviewSection({ form, set, git }: SectionProps) {
  const t = useT().settings;
  const fromGit = git.name || git.email;
  return (
    <Card>
      <h3>{t.review.title}</h3>
      <p className="muted">{t.review.text}</p>
      <Field label={t.reviewer} hint={fromGit ? t.reviewerFromGit(fromGit) : t.reviewerNoGit}>
        <input value={form.reviewer} placeholder={fromGit ?? ""} onChange={(e) => set({ reviewer: e.target.value })} />
      </Field>
      <Field label={t.reviewPolicy} tip={t.policyTip}>
        <Segmented options={Object.entries(t.policies).map(([value, label]) => ({ value, label }))} value={form.reviewPolicy} onChange={(v) => set({ reviewPolicy: v })} />
      </Field>
    </Card>
  );
}

export function McpSection(_: SectionProps) {
  const t = useT().settings;
  const [exe, setExe] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => { api.mcpCommand().then(setExe).catch(() => {}); }, []);
  const config = JSON.stringify({ mcpServers: { "knowledge-hub": { command: exe, args: ["mcp"] } } }, null, 2);
  const copy = async () => {
    await navigator.clipboard.writeText(config);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Card>
      <h3>{t.mcp.title}</h3>
      <p className="muted">{t.mcp.text}</p>
      <pre className="mmd-src">{config}</pre>
      <div className="row">
        <Button size="small" onClick={copy}>{copied ? t.copied : t.copy}</Button>
      </div>
      <p className="hint">{t.mcp.tools}</p>
    </Card>
  );
}

export function AppearanceSection(_: SectionProps) {
  const t = useT().settings;
  const locale = useLocale();
  const theme = useTheme();
  return (
    <Card>
      <h3>{t.appearance.title}</h3>
      <Field label={t.language} tip={t.languageTip}>
        <Segmented<Locale> options={LOCALES.map((l) => ({ value: l.id, label: l.label }))} value={locale} onChange={setLocale} />
      </Field>
      <Field label={t.theme}>
        <Segmented<ThemeId> options={THEMES.map((x) => ({ value: x.id, label: themeText(x.id).label }))} value={theme} onChange={setTheme} />
      </Field>
    </Card>
  );
}
