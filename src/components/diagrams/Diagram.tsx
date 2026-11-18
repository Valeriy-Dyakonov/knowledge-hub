import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useTheme } from "../../theme";

let seq = 0;

const isDark = (theme: string) =>
  theme === "dark" || theme === "graphite" || (theme === "system" && typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches);

const MIN = 0.1;
const MAX = 4;
const clamp = (s: number) => Math.min(MAX, Math.max(MIN, s));

interface View { scale: number; x: number; y: number }

/**
 * Renders Mermaid text to SVG (Mermaid is loaded lazily: it is large and only needed on diagram screens), in a
 * viewport with zoom and pan: Ctrl+wheel zooms at the cursor, wheel and drag move, buttons zoom/fit, full screen.
 * With `nodes` and `onNode`, clicking a node reports its logical key — used to expand groups and drill down.
 */
export function Diagram(props: { text: string; nodes?: Record<string, string>; onNode?: (key: string) => void; height?: number }) {
  const t = useT().diagrams;
  const theme = useTheme();
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const size = useRef({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [full, setFull] = useState(false);
  const [error, setError] = useState("");
  const onNode = useRef(props.onNode);
  onNode.current = props.onNode;
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  /** Scale so the whole diagram fits, never above 100 %, centred. */
  const fit = useCallback(() => {
    const vp = viewport.current;
    const { w, h } = size.current;
    if (!vp || !w || !h) return;
    const scale = clamp(Math.min(1, (vp.clientWidth - 24) / w, (vp.clientHeight - 24) / h));
    setView({ scale, x: (vp.clientWidth - w * scale) / 2, y: Math.max(12, (vp.clientHeight - h * scale) / 2) });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: isDark(theme) ? "dark" : "default", flowchart: { htmlLabels: true } });
      try {
        const { svg } = await mermaid.render(`mmd-${++seq}`, props.text);
        if (cancelled || !canvas.current) return;
        canvas.current.innerHTML = svg;
        setError("");
        const el = canvas.current.querySelector("svg");
        if (el) {
          // Natural size from the viewBox; zoom is done by our transform, not by Mermaid's max-width.
          const vb = el.viewBox.baseVal;
          size.current = { w: vb?.width || el.getBoundingClientRect().width, h: vb?.height || el.getBoundingClientRect().height };
          el.style.maxWidth = "none";
          el.setAttribute("width", String(size.current.w));
          el.setAttribute("height", String(size.current.h));
        }
        // Mermaid gives flowchart nodes DOM ids like "...flowchart-n3-12": map them back to our node keys.
        if (props.nodes) {
          for (const node of canvas.current.querySelectorAll<SVGGElement>("g.node")) {
            const id = /flowchart-(n\d+)-\d+$/.exec(node.id)?.[1];
            const key = id ? props.nodes[id] : undefined;
            if (!key) continue;
            node.classList.add("clickable");
            node.addEventListener("click", () => { if (!drag.current?.moved) onNode.current?.(key); });
          }
        }
        fit();
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [props.text, theme]);

  useEffect(() => { fit(); }, [full]);

  const zoomAt = (factor: number, cx?: number, cy?: number) => setView((v) => {
    const vp = viewport.current;
    const px = cx ?? (vp ? vp.clientWidth / 2 : 0);
    const py = cy ?? (vp ? vp.clientHeight / 2 : 0);
    const scale = clamp(v.scale * factor);
    const k = scale / v.scale;
    return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
  });

  // Native listener: React's wheel handler is passive, and zooming must not scroll the page.
  useEffect(() => {
    const vp = viewport.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = vp.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    // A few pixels of jitter is still a click on a node, not a drag.
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) viewport.current?.setPointerCapture(e.pointerId);
    d.moved = true;
    setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  };
  const onPointerUp = () => {
    // Keep `moved` for the click that follows this pointerup, then forget the drag.
    setTimeout(() => { drag.current = null; }, 0);
  };

  return (
    <div className={`diagram-box ${full ? "full" : ""}`}>
      <div className="zoombar">
        <button onClick={() => zoomAt(1 / 1.25)} title={t.zoom.out}>−</button>
        <button onClick={() => setView((v) => ({ ...v, scale: 1 }))} title={t.zoom.reset}>{Math.round(view.scale * 100)}%</button>
        <button onClick={() => zoomAt(1.25)} title={t.zoom.in}>+</button>
        <button onClick={fit} title={t.zoom.fitTip}>{t.zoom.fit}</button>
        <button onClick={() => setFull(!full)} title={full ? t.zoom.exitFull : t.zoom.full}>{full ? "⤡" : "⤢"}</button>
        <span className="hint">{t.zoom.hint}</span>
      </div>
      <div
        className="diagram-viewport"
        ref={viewport}
        style={full ? undefined : { height: props.height ?? 520 }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={fit}
      >
        <div className="diagram-canvas" ref={canvas} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} />
      </div>
      {error && <p className="error">{t.renderError(error)}</p>}
      {!full && (
        <details className="help">
          <summary>{t.source}</summary>
          <pre className="mmd-src">{props.text}</pre>
        </details>
      )}
    </div>
  );
}
