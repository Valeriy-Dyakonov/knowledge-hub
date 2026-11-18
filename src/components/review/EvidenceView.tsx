import { useEffect, useState } from "react";
import { api } from "../../api";
import { useT } from "../../i18n";
import type { Evidence } from "../../types";
import { CodeView } from "../code/CodeView";
import { Button } from "../ui";

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

/** Visible evidence: the whole file in a read-only viewer, scrolled to the claimed lines, which are highlighted. */
export function EvidenceView(props: { evidence: Evidence; repoPath: string }) {
  const t = useT().review;
  const { evidence: e } = props;
  const [text, setText] = useState<string | null | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let live = true;
    read(props.repoPath, e.path).then((x) => live && setText(x), () => live && setText(null));
    return () => { live = false; };
  }, [props.repoPath, e.path]);

  const start = e.lines?.start;
  const end = e.lines?.end ?? start;

  return (
    <div className="evidence">
      <div className="ev-head">
        <code>{e.path}{start ? `:${start}${end !== start ? `-${end}` : ""}` : ""}</code>
        <span className="hint">@{e.commit.slice(0, 7)}</span>
        <span className="spacer" />
        <span className="hint">{t.searchHint}</span>
        {text && <Button size="small" variant="ghost" onClick={() => setExpanded(!expanded)}>{expanded ? t.collapse : t.expand}</Button>}
      </div>
      {text === null && <p className="hint ev-missing">{t.codeUnavailable}</p>}
      {text && <CodeView text={text} path={e.path} lines={start ? { start, end: end ?? start } : undefined} height={expanded ? 620 : 260} />}
    </div>
  );
}
