import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StreamParser } from "@codemirror/language";
import { java, kotlin } from "@codemirror/legacy-modes/mode/clike";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { xml } from "@codemirror/legacy-modes/mode/xml";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, drawSelection, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";

// Read-only: the hub never writes to analysed repositories, the viewer only shows code next to a claim.

const MODES: [RegExp, StreamParser<unknown>][] = [
  [/\.kts?$/i, kotlin as StreamParser<unknown>],
  [/\.java$/i, java as StreamParser<unknown>],
  [/\.ya?ml$/i, yaml as StreamParser<unknown>],
  [/\.sql$/i, standardSQL as StreamParser<unknown>],
  [/\.(xml|pom)$/i, xml as StreamParser<unknown>],
  [/\.properties$/i, properties as StreamParser<unknown>],
];

function language(path: string): Extension {
  const mode = MODES.find(([re]) => re.test(path))?.[1];
  return mode ? StreamLanguage.define(mode) : [];
}

// Colours come from the theme tokens (styles/themes.css), so the viewer follows light/dark themes.
const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword, tags.operatorKeyword], color: "var(--code-keyword)", fontWeight: "600" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--code-string)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--code-number)" },
  { tag: [tags.typeName, tags.className, tags.tagName], color: "var(--code-type)" },
  { tag: [tags.meta, tags.annotation, tags.attributeName], color: "var(--code-annotation)" },
  { tag: [tags.propertyName, tags.definition(tags.variableName)], color: "var(--code-property)" },
]);

const theme = EditorView.theme({
  "&": { backgroundColor: "var(--card)", color: "var(--text)", fontSize: "12.5px" },
  ".cm-content": { fontFamily: "var(--font-mono)", caretColor: "var(--text)" },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--muted)", border: "none", borderRight: "1px solid var(--line)" },
  ".cm-evidence": { backgroundColor: "color-mix(in srgb, var(--accent) 16%, transparent)" },
  ".cm-evidence-gutter": { color: "var(--accent)", fontWeight: "700" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--warn) 25%, transparent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "color-mix(in srgb, var(--accent) 25%, transparent)" },
  ".cm-panels": { backgroundColor: "var(--bg)", color: "var(--text)", borderColor: "var(--line)" },
  ".cm-panel input, .cm-panel button": { fontSize: "12px" },
});

function evidenceLines(state: EditorState, from: number, to: number): Extension {
  const b = new RangeSetBuilder<Decoration>();
  const last = Math.min(to, state.doc.lines);
  for (let n = Math.max(1, from); n <= last; n++) b.add(state.doc.line(n).from, state.doc.line(n).from, Decoration.line({ class: "cm-evidence" }));
  return EditorView.decorations.of(b.finish());
}

/** A whole file, read-only, with the evidence lines highlighted and scrolled into view. Ctrl+F searches. */
export function CodeView(props: { text: string; path: string; lines?: { start: number; end: number }; height: number }) {
  const host = useRef<HTMLDivElement>(null);
  const { text, path, lines, height } = props;

  useEffect(() => {
    if (!host.current) return;
    const base = EditorState.create({ doc: text });
    const state = EditorState.create({
      doc: text,
      extensions: [
        EditorState.readOnly.of(true),
        lineNumbers(),
        highlightSpecialChars(),
        drawSelection(),
        language(path),
        syntaxHighlighting(highlight),
        search({ top: true }),
        highlightSelectionMatches(),
        keymap.of(searchKeymap),
        theme,
        lines ? evidenceLines(base, lines.start, lines.end) : [],
      ],
    });
    const view = new EditorView({ state, parent: host.current });
    if (lines && lines.start <= state.doc.lines) {
      view.dispatch({ effects: EditorView.scrollIntoView(state.doc.line(lines.start).from, { y: "center" }) });
    }
    return () => view.destroy();
  }, [text, path, lines?.start, lines?.end]);

  return <div className="codeview" ref={host} style={{ height }} />;
}
