import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useTheme } from "../../theme";

let seq = 0;

const isDark = (theme: string) =>
  theme === "dark" || theme === "graphite" || (theme === "system" && typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches);

/** Renders Mermaid text to SVG. Mermaid is loaded lazily: it is large and only needed on diagram screens. */
export function Diagram(props: { text: string }) {
  const t = useT().diagrams;
  const theme = useTheme();
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: isDark(theme) ? "dark" : "default", flowchart: { htmlLabels: true } });
      try {
        const { svg } = await mermaid.render(`mmd-${++seq}`, props.text);
        if (!cancelled && ref.current) {
          ref.current.innerHTML = svg;
          setError("");
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [props.text, theme]);

  return (
    <>
      <div className="diagram" ref={ref} />
      {error && <p className="error">{t.renderError(error)}</p>}
      <details className="help">
        <summary>{t.source}</summary>
        <pre className="mmd-src">{props.text}</pre>
      </details>
    </>
  );
}
