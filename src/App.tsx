import { useEffect, useState } from "react";
import { api, inTauri } from "./api";
import Diagrams from "./components/diagrams/Diagrams";
import Features from "./components/features/Features";
import Repos from "./components/repos/Repos";
import Review from "./components/review/Review";
import RunScreen from "./components/run/RunScreen";
import Settings from "./components/settings/Settings";
import TitleBar from "./components/TitleBar";
import { useLocale, useT } from "./i18n";
import { defaultSettings, type RepoEntry, type Settings as S } from "./types";

type Tab = "repos" | "run" | "features" | "diagrams" | "review";
const TABS: Tab[] = ["repos", "run", "features", "diagrams", "review"];
const REPO_KEY = "hub.repo";

function readSelected(): string | null {
  try { return localStorage.getItem(REPO_KEY); } catch { return null; }
}

export default function App() {
  // Subscribing here re-renders the whole tree on a language switch.
  useLocale();
  const t = useT();
  const [settings, setSettings] = useState<S>(defaultSettings);
  const [ready, setReady] = useState(!inTauri);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("repos");
  const [selected, setSelected] = useState<string | null>(readSelected);

  useEffect(() => {
    if (!inTauri) return;
    api.loadSettings()
      .then((s) => {
        setSettings({ ...defaultSettings, ...s });
        if (s.repos.length && readSelected()) setTab("run");
      })
      .finally(() => setReady(true));
  }, []);

  const select = (path: string | null) => {
    setSelected(path);
    try { if (path) localStorage.setItem(REPO_KEY, path); else localStorage.removeItem(REPO_KEY); } catch { /* storage unavailable */ }
  };

  const saveSettings = async (s: S) => {
    await api.saveSettings(s);
    setSettings(s);
  };

  const repo: RepoEntry | undefined = settings.repos.find((r) => r.path === selected);
  if (!ready) return null;

  return (
    <div className="shell">
      <TitleBar settingsOpen={settingsOpen} onToggleSettings={() => setSettingsOpen(!settingsOpen)} />
      {settingsOpen ? (
        <div className="scroll">
          <div className="app">
            <header className="pagehead">
              <button className="back" onClick={() => setSettingsOpen(false)}>
                <svg viewBox="0 0 16 16"><path d="M10 3L5 8l5 5" /></svg>{t.settings.back}
              </button>
              <h2>{t.settings.title}</h2>
            </header>
            {inTauri ? <Settings settings={settings} onSave={saveSettings} /> : <p className="muted">{t.common.desktopOnly}</p>}
          </div>
        </div>
      ) : (
        <div className="body">
          <nav className="sidenav">
            {repo && <div className="sn-repo" title={repo.path}>{repo.name}</div>}
            {TABS.map((id) => (
              <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>{t.shell.nav[id]}</button>
            ))}
          </nav>
          <div className="scroll">
            <main className="app">
              <div className="pagegap" />
              {tab === "repos" && <Repos settings={settings} selected={selected} onSelect={(p) => { select(p); setTab("run"); }} onSave={saveSettings} />}
              {tab !== "repos" && !repo && <NoRepo onGo={() => setTab("repos")} />}
              {tab === "run" && repo && <RunScreen repo={repo} settings={settings} />}
              {tab === "features" && repo && <Features repo={repo} />}
              {tab === "diagrams" && repo && <Diagrams repo={repo} />}
              {tab === "review" && repo && <Review repo={repo} settings={settings} />}
            </main>
          </div>
        </div>
      )}
    </div>
  );
}

function NoRepo(props: { onGo: () => void }) {
  const t = useT().shell;
  return (
    <section className="card empty">
      <h3>{t.noRepo}</h3>
      <p className="muted">{t.noRepoHint}</p>
      <button className="btn primary" onClick={props.onGo}>{t.nav.repos}</button>
    </section>
  );
}
