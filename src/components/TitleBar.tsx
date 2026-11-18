import { useEffect, useState } from "react";
import { inTauri } from "../api";
import { useT } from "../i18n";

type Win = { minimize(): Promise<void>; toggleMaximize(): Promise<void>; close(): Promise<void>; isMaximized(): Promise<boolean>; onResized(cb: () => void): Promise<() => void> };

/** Custom window title bar (the native one is off via "decorations": false): app name, version, settings, window controls. */
export default function TitleBar(props: { settingsOpen: boolean; onToggleSettings: () => void }) {
  const t = useT().shell.titlebar;
  const [win, setWin] = useState<Win | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [version, setVersion] = useState("");

  useEffect(() => {
    if (!inTauri) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const w = getCurrentWindow() as unknown as Win;
      setWin(w);
      setMaximized(await w.isMaximized());
      unlisten = await w.onResized(() => { w.isMaximized().then(setMaximized).catch(() => {}); });
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        setVersion(await getVersion());
      } catch { /* version label is optional */ }
    })();
    return () => unlisten?.();
  }, []);

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="tb-title" data-tauri-drag-region>
        Knowledge Hub{version && <span className="tb-ver" data-tauri-drag-region>v{version}</span>}
      </div>
      <div className="tb-fill" data-tauri-drag-region />
      <button className={`tb-btn tb-gear ${props.settingsOpen ? "on" : ""}`} aria-label={t.settings} title={props.settingsOpen ? t.closeSettings : t.settings} onClick={props.onToggleSettings}>
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
      </button>
      {win && <span className="tb-sep" />}
      {win && (
        <div className="tb-controls">
          <button className="tb-btn" aria-label={t.minimize} onClick={() => win.minimize()}>
            <svg viewBox="0 0 10 10"><path d="M0 5h10" /></svg>
          </button>
          <button className="tb-btn" aria-label={maximized ? t.restore : t.maximize} onClick={() => win.toggleMaximize()}>
            {maximized
              ? <svg viewBox="0 0 10 10"><path d="M2 0.5h7.5v7.5M0.5 2h7.5v7.5h-7.5z" /></svg>
              : <svg viewBox="0 0 10 10"><path d="M0.5 0.5h9v9h-9z" /></svg>}
          </button>
          <button className="tb-btn tb-close" aria-label={t.close} onClick={() => win.close()}>
            <svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0l-10 10" /></svg>
          </button>
        </div>
      )}
    </div>
  );
}
