import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";
import type { ErrorParams } from "./i18n/messages/ru/errors";
import type { ReviewBackend } from "./lib/review/service";
import type {
  GeneratedFile, JournalEntry, KnowledgeModel, LogEntry, RepoInfo, ReviewAnswer, ReviewBatch, ReviewQuestion, RunRecord, ScanResult, SearchHit, Settings, StoredBatch,
} from "./types";

/** A backend failure worded in the UI language; `String(e)` gives just the message. */
export class BackendError extends Error {
  constructor(readonly code: string, readonly params: ErrorParams, message: string) {
    super(message);
    this.name = "BackendError";
  }
  toString() {
    return this.message;
  }
}

/** Turns `{ code, params }` from Rust (or thrown by `lib/`) into a worded error. */
export function localize(e: unknown): unknown {
  if (!e || typeof e !== "object" || !("code" in e) || e instanceof BackendError) return e;
  const { code, params = {} } = e as { code: string; params?: ErrorParams };
  const m = t().errors;
  const word = m.codes[code];
  const text = word ? word(params) : m.unknown(code, Object.values(params).filter(Boolean).join(", "));
  return new BackendError(code, params, text);
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw localize(e);
  }
}

/** What the analysis needs from the backend; tests pass a fake. */
export interface Backend {
  inspectRepo(path: string): Promise<RepoInfo>;
  scanRepo(path: string): Promise<ScanResult>;
  loadModel(serviceId: string): Promise<KnowledgeModel | null>;
  saveModel(serviceId: string, model: KnowledgeModel): Promise<void>;
  writeGenerated(serviceId: string, files: GeneratedFile[]): Promise<void>;
  saveRun(run: RunRecord): Promise<void>;
  saveCheckpoint(serviceId: string, runId: string, state: unknown): Promise<void>;
  loadCheckpoint(serviceId: string, runId: string): Promise<unknown | null>;
  appendRunLog(serviceId: string, runId: string, entries: LogEntry[]): Promise<void>;
  indexService(serviceId: string): Promise<number>;
  llmChat(system: string, user: string): Promise<string>;
}

export const api = {
  loadSettings: () => call<Settings>("load_settings"),
  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),
  setSecret: (name: string, value: string) => call<void>("set_secret", { name, value }),
  secretsStatus: () => call<Record<string, boolean>>("secrets_status"),
  knowledgeDir: () => call<string>("knowledge_dir"),

  inspectRepo: (path: string) => call<RepoInfo>("inspect_repo", { path }),
  scanRepo: (path: string) => call<ScanResult>("scan_repo", { path }),
  readRepoFile: (path: string, file: string) => call<string>("read_repo_file", { path, file }),

  listServices: () => call<string[]>("list_services"),
  loadModel: (serviceId: string) => call<KnowledgeModel | null>("load_model", { serviceId }),
  saveModel: (serviceId: string, model: KnowledgeModel) => call<void>("save_model", { serviceId, model }),
  writeGenerated: (serviceId: string, files: GeneratedFile[]) => call<void>("write_generated", { serviceId, files }),
  readGenerated: (serviceId: string, relativePath: string) => call<string | null>("read_generated", { serviceId, relativePath }),

  saveRun: (run: RunRecord) => call<void>("save_run", { run }),
  listRuns: (serviceId: string) => call<RunRecord[]>("list_runs", { serviceId }),
  saveCheckpoint: (serviceId: string, runId: string, state: unknown) => call<void>("save_checkpoint", { serviceId, runId, state }),
  loadCheckpoint: (serviceId: string, runId: string) => call<unknown | null>("load_checkpoint", { serviceId, runId }),
  appendRunLog: (serviceId: string, runId: string, entries: LogEntry[]) => call<void>("append_run_log", { serviceId, runId, entries }),
  runLogs: (serviceId: string, runId: string) => call<LogEntry[]>("run_logs", { serviceId, runId }),

  saveBatch: (serviceId: string, batch: ReviewBatch) => call<void>("save_batch", { serviceId, batch }),
  findBatch: (serviceId: string, batchId: string) => call<StoredBatch | null>("find_batch", { serviceId, batchId }),
  openBatches: (serviceId: string) => call<StoredBatch[]>("open_batches", { serviceId }),
  saveAnswer: (serviceId: string, batchId: string, answer: ReviewAnswer) => call<void>("save_answer", { serviceId, batchId, answer }),
  closeBatch: (serviceId: string, batchId: string, state: "CLOSED" | "REJECTED", flags: string[]) => call<void>("close_batch", { serviceId, batchId, state, flags }),
  appendJournal: (serviceId: string, entries: JournalEntry[]) => call<void>("append_journal", { serviceId, entries }),
  reviewJournal: (serviceId: string) => call<JournalEntry[]>("review_journal", { serviceId }),
  addQuestion: (serviceId: string, question: ReviewQuestion) => call<void>("add_question", { serviceId, question }),
  reviewQuestions: (serviceId: string) => call<ReviewQuestion[]>("review_questions", { serviceId }),

  indexService: (serviceId: string) => call<number>("index_service", { serviceId }),
  search: (query: string, serviceId?: string, limit?: number) => call<SearchHit[]>("search", { query, serviceId, limit }),
  mcpCommand: () => call<string>("mcp_command"),

  llmChat: (system: string, user: string) => call<string>("llm_chat", { system, user }),
};

export const reviewBackend: ReviewBackend = api;

export const backend: Backend = api;

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
