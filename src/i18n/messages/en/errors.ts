import type { errors as ru } from "../ru/errors";

export const errors: typeof ru = {
  unknown: (code, details) => `Error ${code}${details ? `: ${details}` : ""}`,
  codes: {
    raw: (p) => String(p.detail ?? ""),
    service: (p) => `${p.service}: ${p.detail}`,
    http: (p) => `${p.service}: HTTP ${p.status}${p.body ? ` — ${p.body}` : ""}`,
    repoNotFound: (p) => `Repository folder not found: ${p.path}`,
    pathOutsideRepo: (p) => `Path outside the repository: ${p.path}`,
    noExtractor: () => "No extractor for this repository (Kotlin + Spring Boot is supported)",
    stageFailed: (p) => `Stage ${p.id} failed${p.detail ? `: ${p.detail}` : ""}`,
    runNotFound: (p) => `Run not found: ${p.runId}`,
    runAlreadyCompleted: () => "The run is already completed",
    storeFailed: (p) => `Could not read or write the knowledge base: ${p.detail ?? p.file ?? ""}`,
    schemaUnsupported: (p) => `The knowledge file is newer than the app (schema version ${p.version}). Update the app.`,
    invalidArgument: (p) => `Invalid value: ${p.value ?? p.path ?? ""}`,
    stateFailed: (p) => `Working database (.state) error: ${p.detail ?? ""}`,
    unknownSecret: (p) => `Unknown secret: ${p.secret}`,
    keychainNotSaved: () => "The credential store did not keep the value",
    llmNotConfigured: () => "LLM is not configured: set the address and model in Settings",
    llmUnavailable: () => "LLM is unavailable",
    llmNoContent: () => "LLM returned an empty answer",
    llmNoAnswer: () => "LLM did not answer",
    llmBadResponse: (p) => `LLM answered in an unexpected format (${p.reason ?? ""})`,
  },
};
