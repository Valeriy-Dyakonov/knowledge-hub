import { markdownRenderer } from "./markdown";
import { mermaidRenderer } from "./mermaid";
import type { Renderer } from "./types";

/** Registered renderers; a new view format is a new module plus an entry here. */
export const RENDERERS: Renderer[] = [markdownRenderer, mermaidRenderer];

export type { Renderer, ViewSpec } from "./types";
