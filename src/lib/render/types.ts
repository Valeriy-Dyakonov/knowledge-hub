import type { GeneratedFile, KnowledgeModel } from "../../types";

export interface ViewSpec { language: string }

/** Produces views from the model. Never reads the repository and never calls the LLM. */
export interface Renderer {
  readonly id: string;
  render(model: KnowledgeModel, view: ViewSpec): GeneratedFile[];
}
