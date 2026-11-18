import type { diagrams as ru } from "../ru/diagrams";

export const diagrams: typeof ru = {
  title: "Service diagrams",
  context: "Context (L1)",
  contextTip: "The whole service: who triggers it and what it reaches outside. For everyone, including non-technical readers.",
  components: "Components (L2)",
  componentsTip: "Main building blocks and the stores, queues and external APIs they use. Over 12 nodes they are grouped by kind.",
  empty: "Diagrams appear after the first analysis.",
  renderError: (e) => `Could not draw the diagram: ${e}`,
  source: "Mermaid source",
};
