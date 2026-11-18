import { useEffect, useState } from "react";
import { api } from "../../api";
import { useT } from "../../i18n";
import type { Evidence } from "../../types";
import { Button } from "../ui";

const CONTEXT = 3;
const cache = new Map<string, Promise<string>>();

function read(repo: string, path: string): Promise<string> {
  const key = `${repo}\u0000${path}`;
  let p = cache.get(key);
  if (!p) {
    p = api.readRepoFile(repo, path);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

/** Visible evidence: the code fragment with its lines highlighted, the path, and a link into the IDE. */
export function EvidenceView(props: { evidence: Evidence; repoPath: string; ideUrl: string }) {
  const t = useT().review;
  const { evidence: e } = props;
  const [text, setText] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    read(props.repoPath, e.path).then((x) => live && setText(x), () => live && setText(null));
    return () => { live = false; };
  }, [props.repoPath, e.path]);

  const start = e.lines?.start ?? 1;
  const end = e.lines?.end ?? start;
  const lines = text?.split(/\r?\n/) ?? [];
  const from = Math.max(1, start - CONTEXT);
  const to = Math.min(lines.length, end + CONTEXT);

  const open = async () => {
    const abs = `${props.repoPath.replace(/\\/g, "/").replace(/\/$/, "")}/${e.path}`;
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(props.ideUrl.replace("{path}", abs).replace("{line}", String(start)));
  };

  return (
    <div className="evidence">
      <div className="ev-head">
        <code>{e.path}{e.lines ? `:${start}${end !== start ? `-${end}` : ""}` : ""}</code>
        <span className="hint">@{e.commit.slice(0, 7)}</span>
        <span className="spacer" />
        {props.ideUrl && <Button size="small" variant="ghost" onClick={open}>{t.openInIde}</Button>}
      </div>
      {text === null && <p className="hint">{t.codeUnavailable}</p>}
      {text && (
        <pre className="code">
          {lines.slice(from - 1, to).map((l, i) => {
            const n = from + i;
            return <div key={n} className={n >= start && n <= end ? "hl" : ""}><span className="ln">{n}</span>{l || " "}</div>;
          })}
        </pre>
      )}
    </div>
  );
}
