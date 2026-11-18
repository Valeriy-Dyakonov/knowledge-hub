import type { ConfigInfo, ConfigProperty, ConfigUsage, ContextFacts, SourceFacts } from "../../types";

const MASK = "***";

/**
 * Configuration as one table: every property defined in application*.yml/properties (base and per profile) and every
 * one read by code, with who reads it. A `prefix.*` read (`@ConfigurationProperties`) is attached to each defined
 * property under the prefix. A property read by code, defined nowhere and without a default is flagged `missing`.
 */
export function buildConfig(facts: SourceFacts, context: ContextFacts): ConfigInfo {
  const profiles = Object.keys(context.profiles ?? {}).sort();
  const props = new Map<string, ConfigProperty>();
  const get = (key: string) => {
    let p = props.get(key);
    if (!p) props.set(key, (p = { key, profiles: {}, usages: [], secret: false, missing: false, source: context.propertySources?.[key] }));
    return p;
  };
  for (const [k, v] of Object.entries(context.properties)) get(k).value = v;
  for (const [profile, values] of Object.entries(context.profiles ?? {})) for (const [k, v] of Object.entries(values)) get(k).profiles[profile] = v;

  const usages = facts.configUsages ?? [];
  for (const u of usages) {
    const usage: ConfigUsage = { componentId: u.componentId, method: u.method, kind: u.kind, default: u.default, evidence: u.evidence };
    if (u.key.endsWith(".*")) {
      const prefix = u.key.slice(0, -1);
      for (const p of props.values()) if (p.key.startsWith(prefix)) p.usages.push({ ...usage, viaPrefix: u.key });
      continue;
    }
    get(u.key).usages.push(usage);
  }
  for (const p of props.values()) {
    p.secret = p.value === MASK || Object.values(p.profiles).includes(MASK);
    const defined = p.value !== undefined || Object.keys(p.profiles).length > 0;
    p.missing = !defined && p.usages.length > 0 && p.usages.every((u) => u.default === undefined && u.kind !== "properties");
    // Duplicate reads of the same place (e.g. a field and its prefix) are one usage.
    p.usages = p.usages.filter((u, i, all) => all.findIndex((x) => x.componentId === u.componentId && x.method === u.method && x.kind === u.kind) === i);
  }
  return { profiles, properties: [...props.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}
