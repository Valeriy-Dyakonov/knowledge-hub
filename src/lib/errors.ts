/** Errors raised by `lib/` code: a code with params, worded by the UI (`i18n/messages/<lang>/errors.ts`). */
export class HubError extends Error {
  constructor(readonly code: string, readonly params: Record<string, string> = {}) {
    super(Object.keys(params).length ? `${code} ${JSON.stringify(params)}` : code);
    this.name = "HubError";
  }
}

/** `{ code, params }` of any thrown value: backend errors already have this shape. */
export function errorInfo(e: unknown): { code: string; params: Record<string, string> } {
  if (e && typeof e === "object" && "code" in e) {
    const { code, params } = e as { code: unknown; params?: Record<string, unknown> };
    return { code: String(code), params: Object.fromEntries(Object.entries(params ?? {}).map(([k, v]) => [k, String(v)])) };
  }
  return { code: "raw", params: { detail: e instanceof Error ? e.message : String(e) } };
}
