import { markdownRenderer } from "./markdown";
import { mermaidRenderer } from "./mermaid";
import { referenceRenderer } from "./reference";
import type { Renderer } from "./types";

/** Registered renderers; a new view format is a new module plus an entry here. */
export const RENDERERS: Renderer[] = [markdownRenderer, mermaidRenderer, referenceRenderer];

export type { Renderer, ViewSpec } from "./types";
