// Domain model of the knowledge base. Mirrored by src-tauri/src/model/ (same camelCase field names).

export type ServiceId = string;
export type FeatureId = string;
export type ClaimId = string;

/** Language code -> text, e.g. { ru: "Создание возврата", en: "Create refund" }. */
export type LocalizedText = Record<string, string>;

export const SCHEMA_VERSION = 1;

export interface LineRange { start: number; end: number }

/** Where in the code a claim is visible. `fingerprint` hashes the fragment and is used for staleness. */
export interface Evidence {
  repo: string;
  path: string;
  lines?: LineRange;
  commit: string;
  fingerprint: string;
}

export type Origin = "STATIC" | "INFERRED" | "HUMAN";
export type Confidence = "LOW" | "MEDIUM" | "HIGH";
export type ClaimStatus = "PROPOSED" | "CONFIRMED" | "EDITED" | "REJECTED" | "STALE";
export type ClaimKind =
  | "EXISTS" | "BELONGS_TO_FEATURE" | "CALLS" | "READS" | "WRITES_TO" | "PUBLISHES_TO" | "CONSUMES" | "HTTP_CALLS" | "DESCRIBES";
export type SubjectType = "SERVICE" | "FEATURE" | "TRIGGER" | "COMPONENT" | "STEP" | "EDGE" | "SINK";
export type ReviewAction = "CONFIRM" | "EDIT" | "REJECT" | "DONT_KNOW";

export interface SubjectRef { type: SubjectType; id: string }

export interface ReviewInfo { reviewer: string; at: string; action: ReviewAction; comment?: string }

/**
 * Unit of review. `featureId` is null for service-level claims (catalog business names).
 * `analysisPayload` is what the analysis proposed last time: a re-run compares against it to detect conflicts with human edits.
 */
export interface Claim {
  id: ClaimId;
  featureId: FeatureId | null;
  subject: SubjectRef;
  kind: ClaimKind;
  payload: Record<string, string>;
  evidence: Evidence[];
  origin: Origin;
  confidence: Confidence;
  status: ClaimStatus;
  review?: ReviewInfo;
  verifiedAt?: string;
  staleReasons?: string[];
  analysisPayload?: Record<string, string>;
  previousPayload?: Record<string, string>;
  conflict?: Record<string, string>;
}

export interface Service {
  id: ServiceId;
  name: string;
  repo: string;
  branch?: string;
  stack: string[];
  lastAnalyzedCommit?: string;
}

/** ASYNC: an `@Async` method nobody in the project calls — it runs in its own thread, started from outside. */
export type TriggerType = "HTTP" | "MESSAGE" | "SCHEDULE" | "EVENT" | "STARTUP" | "ASYNC" | "CLI";

export interface Trigger {
  id: string;
  type: TriggerType;
  technicalName: string;
  componentId: string;
  method: string;
  attributes: Record<string, string>;
  evidence?: Evidence;
}

export type ComponentKind = "CONTROLLER" | "SERVICE" | "REPOSITORY" | "CLIENT" | "PUBLISHER" | "LISTENER" | "CONFIGURATION" | "COMPONENT";

export interface Component {
  id: string;
  kind: ComponentKind;
  technicalName: string;
  businessName: LocalizedText;
  evidence?: Evidence;
}

export type SinkKind = "DB_TABLE" | "TOPIC" | "QUEUE" | "EXTERNAL_HTTP" | "FILE";

export interface Sink {
  id: string;
  kind: SinkKind;
  technicalName: string;
  businessName: LocalizedText;
}

export type EdgeKind = "CALL" | "READ" | "WRITE" | "PUBLISH" | "CONSUME" | "HTTP_CALL";
export type NodeType = "TRIGGER" | "COMPONENT" | "SINK";

export interface NodeRef { type: NodeType; id: string }

export interface Edge {
  id: string;
  from: NodeRef;
  to: NodeRef;
  kind: EdgeKind;
  label: string;
  origin: Origin;
  confidence: Confidence;
  evidence?: Evidence;
  claimId?: ClaimId;
  /** The call goes to an `@Async` method: the caller does not wait for it. */
  async?: boolean;
}

/** Ordered step of a flow: a component performing an action, reached through `edgeId`. */
export interface Step { order: number; componentId: string; action: string; edgeId?: string }

export type BreakReason =
  | "MULTIPLE_IMPLEMENTATIONS" | "UNRESOLVED_CALL" | "EVENT" | "REFLECTION" | "DYNAMIC_SQL" | "UNRESOLVED_PLACEHOLDER" | "PARSE_ERROR";

/** A place where static tracing could not follow the flow; shown to reviewers. */
export interface FlowBreak { componentId: string; method: string; reason: BreakReason; detail: string; evidence?: Evidence }

export type FeatureStatus = "DRAFT" | "REVIEWED" | "STALE";

export interface Feature {
  id: FeatureId;
  group: string;
  technicalName: string;
  businessName: LocalizedText;
  description: LocalizedText;
  owner?: string;
  aliases: string[];
  triggers: Trigger[];
  componentIds: string[];
  sinkIds: string[];
  edges: Edge[];
  steps: Step[];
  breaks: FlowBreak[];
  claims: Claim[];
}

/** Service-wide nodes shared by features; their business names are service-level claims. */
export interface Catalog { components: Component[]; sinks: Sink[]; claims: Claim[] }

export interface KnowledgeModel {
  schemaVersion: number;
  service: Service;
  catalog: Catalog;
  features: Feature[];
}

// ---- Static facts produced by Rust extractors (stage Scan) ----

export interface MethodFact { name: string; parameterTypes: string[]; evidence?: Evidence }

export interface ComponentFact {
  id: string;
  simpleName: string;
  kind: ComponentKind;
  isInterface: boolean;
  supertypes: string[];
  /** field name -> resolved type id (usually FQN) */
  injected: Record<string, string>;
  methods: MethodFact[];
  attributes: Record<string, string>;
  evidence?: Evidence;
}

export interface TriggerFact { type: TriggerType; componentId: string; method: string; attributes: Record<string, string>; evidence?: Evidence }

export interface CallFact { fromComponent: string; fromMethod: string; targetType: string; targetMethod: string; evidence?: Evidence }

/** `sinkName` may contain `${placeholders}` resolved later from configuration. */
export interface SinkAccessFact {
  componentId: string;
  method: string;
  sinkKind: SinkKind;
  sinkName: string;
  edgeKind: EdgeKind;
  origin: Origin;
  confidence: Confidence;
  attributes: Record<string, string>;
  evidence?: Evidence;
}

export interface EventPublishFact { componentId: string; method: string; eventType?: string; evidence?: Evidence }

export interface UnresolvedFact { componentId: string; method: string; reason: BreakReason; detail: string; evidence?: Evidence }

export interface SourceFacts {
  components: ComponentFact[];
  triggers: TriggerFact[];
  calls: CallFact[];
  sinkAccesses: SinkAccessFact[];
  events: EventPublishFact[];
  unresolved: UnresolvedFact[];
}

export interface ApiOperation { method: string; path: string; operationId?: string; tags: string[]; summary?: string; evidence?: Evidence }

export interface OwnershipRule { pattern: string; owners: string[] }

/** Facts from configuration, API specs, migrations, ownership. Secret values are already redacted. */
export interface ContextFacts {
  properties: Record<string, string>;
  apiOperations: ApiOperation[];
  tables: string[];
  ownership: OwnershipRule[];
}

export interface ScanStep {
  kind: "extractor" | "contextSource";
  id: string;
  version?: string;
  status: "done" | "skipped" | "failed";
  error?: { code: string; params?: Record<string, unknown> };
  /** What the step found: files, components, triggers... or properties, tables... */
  stats?: Record<string, number>;
  millis?: number;
}

/** Live progress of the Rust scan (`scan-progress` events). */
export interface ScanProgress { kind: "extractor" | "contextSource"; id: string; current: number; total: number; item: string }

export interface ScanResult {
  commit: string;
  branch?: string;
  facts: SourceFacts;
  context: ContextFacts;
  steps: ScanStep[];
}

export interface RepoInfo { path: string; name: string; commit: string; branch?: string }

// ---- Runs ----

/** `detail` entries describe individual items (a feature, a request); the journal can hide them. */
export type LogLevel = "info" | "ok" | "warn" | "error" | "detail";

/** Log entries are codes with params; the UI words them (i18n `run.log`). */
export interface LogEntry { at: string; level: LogLevel; stage?: string; code: string; params?: Record<string, string> }

export type RunStatus = "RUNNING" | "COMPLETED" | "FAILED";

export interface LlmLimits { requestsPerMinute: number; maxRequests: number }

export interface RunOptions { serviceId: ServiceId; serviceName: string; repoPath: string; language: string; describe: boolean; llm?: LlmLimits }

export interface RunRecord {
  id: string;
  options: RunOptions;
  commit: string;
  branch?: string;
  status: RunStatus;
  completedStages: string[];
  versions: Record<string, string>;
  startedAt: string;
  finishedAt?: string;
  error?: { code: string; params?: Record<string, unknown> };
}

// ---- Review (docs/04-review.md) ----

export type BatchKind = "REGULAR" | "STATIC_SUMMARY";

/**
 * One reviewable point. `control` items are deliberately wrong claims mixed into a batch; they never reach the model.
 * `options` turns the item into a clarifying question ("which table does this step write to?").
 */
export interface ReviewItem { id: string; claim: Claim; control?: boolean; options?: string[] }

export interface StaticSummary { count: number; byKind: Record<string, number>; files: number; examples: ClaimId[] }

export interface ReviewBatch {
  id: string;
  serviceId: ServiceId;
  policy: string;
  kind: BatchKind;
  reviewer: string;
  owner?: string;
  items: ReviewItem[];
  summary?: StaticSummary;
  openedAt: string;
}

/** Item id of the single answer that closes a static summary batch. */
export const SUMMARY_ITEM = "summary";

/**
 * Answer to one item. EDIT carries the corrected `payload`. A static summary is accepted only when the reviewer types
 * the number of facts it shows (`acknowledgedCount`), which proves the summary was read.
 */
export interface ReviewAnswer {
  itemId: string;
  action: ReviewAction;
  payload?: Record<string, string>;
  comment?: string;
  acknowledgedCount?: number;
  answeredAt: string;
  millisSpent?: number;
}

export interface CloseDecision {
  accepted: boolean;
  reasonCode?: string;
  params?: Record<string, string>;
  flags: string[];
  failedControlItems: string[];
}

export type BatchState = "OPEN" | "CLOSED" | "REJECTED";

export interface StoredBatch { batch: ReviewBatch; state: BatchState; answers: ReviewAnswer[]; flags: string[] }

export interface JournalEntry {
  batchId: string;
  itemId: string;
  claimId: string;
  reviewer: string;
  action: ReviewAction;
  control: boolean;
  at: string;
  millisSpent?: number;
  comment?: string;
}

/** "Не знаю": a question to the feature owner; the claim stays PROPOSED. */
export interface ReviewQuestion {
  id: string;
  serviceId: ServiceId;
  claimId: ClaimId;
  featureId: FeatureId | null;
  owner?: string;
  askedBy: string;
  comment?: string;
  at: string;
}

// ---- Settings (mirror of src-tauri/src/settings.rs) ----

export interface RepoEntry {
  /** Absolute path to the analysed repository (read-only). */
  path: string;
  /** Folder name in the knowledge base. */
  serviceId: string;
  name: string;
}

export interface Settings {
  /** Folder with the knowledge base; empty = Documents/knowledge-hub. */
  knowledgeDir: string;
  repos: RepoEntry[];
  llmBaseUrl: string;
  llmModel: string;
  /** At most this many LLM requests per minute; the analysis waits between requests. */
  llmRequestsPerMinute: number;
  /** At most this many LLM requests in one analysis run. */
  llmMaxRequests: number;
  reviewPolicy: string;
  /** Overrides the reviewer name; empty = `user.name` from the global git config. */
  reviewer: string;
}

export interface GitUser { name?: string; email?: string }

/** Who signs review decisions: the name from Settings, otherwise the git user. */
export const reviewerOf = (s: Settings, git: GitUser): string => s.reviewer.trim() || git.name || git.email || "";

export const defaultSettings: Settings = {
  knowledgeDir: "",
  repos: [],
  llmBaseUrl: "",
  llmModel: "",
  llmRequestsPerMinute: 6,
  llmMaxRequests: 20,
  reviewPolicy: "strict",
  reviewer: "",
};

export interface SearchHit { service: ServiceId; featureId: FeatureId; title: string; snippet: string; status: FeatureStatus; score: number }

/** A file generated from the model (markdown, Mermaid); path is relative to the service folder. */
export interface GeneratedFile { relativePath: string; content: string }
