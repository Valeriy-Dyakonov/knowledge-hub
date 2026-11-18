import type { ApiOperation, ContextFacts, KnowledgeModel, SourceFacts, Trigger, TriggerFact } from "../../types";
import { kebab, simpleName } from "../model/ids";
import { resolvePlaceholders } from "../model/placeholders";
import type { FeatureCandidate, Stage } from "./types";

/**
 * Stage 2: one candidate feature per entry point, grouped by OpenAPI tag, then path resource, then declaring class.
 * Ids already used by the previous model for the same trigger are kept, so ids never change after review.
 */
export const discoverStage: Stage = {
  id: "discover",
  required: true,
  async run(ctx) {
    const scan = ctx.state.scan;
    ctx.state.candidates = scan ? discover(scan.facts, scan.context, ctx.previous) : [];
    ctx.log("ok", "discoverSummary", { candidates: String(ctx.state.candidates.length) });
  },
};

const CLASS_SUFFIXES = ["Controller", "Listener", "Consumer", "Handler", "Scheduler", "Job", "Runner", "Resource", "Endpoint"];

export function discover(facts: SourceFacts, context: ContextFacts, previous: KnowledgeModel | null): FeatureCandidate[] {
  // Internal events are followed inside the publishing flow; only framework/external events are entry points.
  const published = new Set(facts.events.map((e) => e.eventType).filter(Boolean));
  const previousIdByTrigger = new Map<string, string>();
  for (const f of previous?.features ?? []) for (const t of f.triggers) previousIdByTrigger.set(t.id, f.id);
  const names = new Map(facts.components.map((c) => [c.id, c.simpleName]));

  const seen = new Set<string>();
  const triggers = facts.triggers
    .filter((t) => !(t.type === "EVENT" && published.has(t.attributes.eventType)))
    .map((t) => toTrigger(t, context, names))
    .filter((t) => !seen.has(t.id) && seen.add(t.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  const used = new Set<string>();
  return triggers.map((trigger) => {
    const reused = previousIdByTrigger.get(trigger.id);
    const n = naming(trigger, context.apiOperations, names);
    let id = reused ?? `${n.group}/${n.action}`;
    if (!reused && used.has(id)) id = `${n.group}/${n.action}-${kebab(trigger.method)}`;
    const base = id;
    for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
    used.add(id);
    return { id, group: id.split("/")[0], technicalName: trigger.technicalName, triggers: [trigger], groupingReason: reused ? "previousModel" : n.reason };
  });
}

function toTrigger(f: TriggerFact, context: ContextFacts, names: Map<string, string>): Trigger {
  const a: Record<string, string> = {};
  for (const [k, v] of Object.entries(f.attributes)) a[k] = resolvePlaceholders(v, context.properties).value;
  const owner = names.get(f.componentId) ?? simpleName(f.componentId);
  const technicalName = {
    HTTP: () => `${a.httpMethod} ${a.path}`,
    MESSAGE: () => `${a.broker ?? "message"} ${a.destination}`,
    SCHEDULE: () => `schedule ${a.cron ?? a.fixedRate ?? a.fixedDelay ?? ""} ${owner}.${f.method}`.replace(/\s+/g, " "),
    EVENT: () => `event ${simpleName(a.eventType ?? "")}`,
    STARTUP: () => `startup ${owner}.${f.method}`,
    CLI: () => `cli ${owner}.${f.method}`,
  }[f.type]();
  const id = f.type === "HTTP"
    ? `http:${a.httpMethod} ${a.path}`
    : f.type === "MESSAGE"
      ? `message:${a.destination}:${f.componentId}.${f.method}`
      : `${f.type.toLowerCase()}:${f.componentId}.${f.method}`;
  return { id, type: f.type, technicalName: technicalName.trim(), componentId: f.componentId, method: f.method, attributes: a, evidence: f.evidence };
}

interface Naming { group: string; action: string; reason: string }

function naming(t: Trigger, ops: ApiOperation[], names: Map<string, string>): Naming {
  if (t.type === "HTTP") {
    const method = t.attributes.httpMethod ?? "";
    const path = t.attributes.path ?? "";
    const op = ops.find((o) => o.method.toUpperCase() === method.toUpperCase() && samePath(o.path, path));
    const tag = op?.tags[0];
    const rest = restNaming(method, path);
    if (tag && op?.operationId) return { group: kebab(tag), action: kebab(op.operationId), reason: "openApiTag" };
    if (tag) return { group: kebab(tag), action: rest.action, reason: "openApiTag" };
    if (rest.resource) return { group: rest.resource, action: rest.action, reason: "path" };
  }
  return { group: classGroup(t.componentId, names), action: kebab(t.method), reason: "class" };
}

function classGroup(componentId: string, names: Map<string, string>): string {
  let s = names.get(componentId) ?? simpleName(componentId);
  for (const suffix of CLASS_SUFFIXES) if (s.length > suffix.length && s.endsWith(suffix)) s = s.slice(0, -suffix.length);
  return kebab(s) || "misc";
}

const isVariable = (seg: string) => seg.startsWith("{") || seg.startsWith(":");

/** `POST /api/v1/refunds` -> refunds/create, `GET /refunds/{id}` -> refunds/get, `POST /refunds/{id}/approve` -> refunds/approve. */
export function restNaming(method: string, path: string): { resource?: string; action: string } {
  const meaningful = path.split("/").filter((s) => s && s !== "api" && s !== "internal" && s !== "public" && !/^v\d+$/.test(s));
  const literal = meaningful.filter((s) => !isVariable(s));
  const last = meaningful[meaningful.length - 1];
  const m = method.toUpperCase();
  let action: string;
  if (last && !isVariable(last) && literal.length > 1) action = kebab(last);
  else if (m === "POST") action = "create";
  else if (m === "GET") action = last && isVariable(last) ? "get" : "list";
  else if (m === "PUT" || m === "PATCH") action = "update";
  else if (m === "DELETE") action = "delete";
  else action = m.toLowerCase() || "call";
  return { resource: literal[0] ? kebab(literal[0]) : undefined, action };
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/^\/+|\/+$/g, "").split("/").map((s) => (isVariable(s) ? "{}" : s)).join("/");
  return norm(a) === norm(b);
}
