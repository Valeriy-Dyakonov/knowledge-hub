const PLACEHOLDER = /\$\{([^}:]+)(?::([^}]*))?}/g;

// Spring relaxed binding: my-prop, myProp and my_prop refer to the same key.
const relaxed = (key: string) => key.replace(/_/g, "-").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();

export interface Resolution { value: string; unresolved: string[] }

/** Resolves Spring-style `${key:default}` placeholders against flattened configuration properties. */
export function resolvePlaceholders(text: string, properties: Record<string, string>): Resolution {
  const unresolved: string[] = [];
  let current = text;
  for (let i = 0; i < 5 && /\$\{[^}]+}/.test(current); i++) {
    current = current.replace(PLACEHOLDER, (_, rawKey: string, def?: string) => {
      const key = rawKey.trim();
      const v = properties[key] ?? properties[relaxed(key)] ?? def;
      if (v !== undefined) return v;
      if (!unresolved.includes(key)) unresolved.push(key);
      return `<${key}>`;
    });
  }
  return { value: current, unresolved };
}
