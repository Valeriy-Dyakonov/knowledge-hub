# Knowledge Hub — notes for agents and contributors

A standalone service that analyses a source repository (first target: Kotlin + Spring Boot), splits it into **features**, traces each process from its trigger to the sink (database, queue, external service), and stores the result as a **human-reviewed knowledge base**. Harnesses/agents consume it through **MCP**. Design docs live in `docs/` (Russian); read `docs/00-vision.md` and `docs/01-architecture.md` first.

**Current phase: design / M0.** There is no code yet. The milestone list is in `docs/09-roadmap.md`. Do not add CI/GitLab triggers, webhooks or auto-update on merge — out of scope for now.

## Stack (planned)
- Kotlin, Spring Boot, Gradle (Kotlin DSL), multi-module.
- Persistence for runs/reviews/index: SQLite (FTS5) to start; behind ports, so it can change.
- MCP server module; LLM through an OpenAI-compatible port (corporate gateway).

## Commands
Not available yet. When the skeleton exists, document here: build, test, run the app, run one analysis from CLI. Keep this table in sync with `build.gradle.kts`.

## Planned layout (Gradle modules)
- `kb-domain` — pure Kotlin, no Spring: `Service`, `Feature`, `Trigger`, `Step`, `Component`, `Sink`, `Claim`, `Evidence`, `ReviewItem`. Nothing here depends on any other module.
- `kb-ports` — interfaces only (SPI): `Extractor`, `ContextSource`, `LlmClient`, `KnowledgeStore`, `Indexer`, `Renderer`, `ReviewPolicy`, `KnowledgeEndpoint`.
- `kb-pipeline` — `AnalysisPipeline`, `Stage`, `RunContext`, run persistence/resume. Orchestrates only; no parsing, no LLM calls inline.
- `kb-extractor-kotlin-spring` — first `Extractor` (annotations -> entry points and sinks).
- `kb-llm-openai` — `LlmClient` for an OpenAI-compatible API.
- `kb-store-fs` — `KnowledgeStore` on a local folder (git-friendly layout, see `docs/07-storage.md`).
- `kb-index-sqlite` — `Indexer` (FTS5); vector index is a later adapter.
- `kb-render-markdown` — markdown + Mermaid `Renderer`s generated from the model.
- `kb-review` — `ReviewPolicy` implementations and review use-cases (HTTP API for the UI).
- `kb-mcp` — MCP server (`KnowledgeEndpoint`).
- `kb-app` — Spring Boot wiring only (component scan, config, CLI entry).

Dependency rule: adapters depend on `kb-ports` and `kb-domain`; `kb-domain` depends on nothing; only `kb-app` knows all modules. Plugins are discovered by injecting `List<Port>` — adding a module to the classpath must be enough to enable it.

## Checklists

**New extractor** (another language/framework):
1. New module `kb-extractor-<name>` implementing `Extractor`; `supports(repo)` decides applicability.
2. Emit only facts with `Evidence` (path, lines, commit). Anything inferred is `origin = INFERRED` with a confidence.
3. Register as a Spring bean (auto-configuration); no change to `kb-pipeline`.
4. Fixture repo + golden test of extracted entry points/sinks.

**New context source** (OpenAPI, migrations, Jira, runtime mappings): implement `ContextSource`, same evidence rules.

**New renderer**: implement `Renderer` (input: reviewed model, output: files). Never read the repository, never call the LLM.

**New store / index / LLM adapter**: implement the port in its own module; contract tests live next to the port.

**New MCP tool**: add to `kb-mcp`, response uses the standard envelope (`docs/08-mcp.md`) with review status and verified commit.

**New review rule**: implement `ReviewPolicy` or a rule inside it; document in `docs/04-review.md`.

## Contracts that must not break (once they exist)
- The on-disk knowledge layout and the model schema version (`schemaVersion` in `service.yaml`).
- MCP tool names, arguments and the response envelope.
- Claim and evidence identifiers (stable across re-runs, so reviews survive re-analysis).

## Rules
- **Read-only toward analysed repositories.** The hub never writes to them.
- **Every claim has evidence.** No evidence -> `origin = INFERRED`, low confidence, goes to review first.
- **Deterministic first, LLM second.** Static facts are the baseline; if the LLM fails, the run still produces the static model (like `HeuristicAllocator` fallback in worklog-tracker).
- **Views are generated.** Markdown and diagrams come from the model through `Renderer`s; do not hand-edit generated files (they carry a header saying so).
- **No bulk approval.** Review actions are per claim/diff; see `docs/04-review.md`. Do not add "approve all".
- **Errors are codes.** Use `HubError(code, params)`; user-facing text is produced by the UI/i18n layer, never by services.
- **Secrets never leave the process.** Redact tokens/keys before anything goes to the LLM or the store.
- **Reviewed vs pending is explicit.** Anything served over MCP carries its review status.

## Conventions
- Small focused modules; prefer a registry/strategy (injected `List<Port>`) over a growing `when`.
- Comments only for a non-obvious "why".
- Code, comments, commit messages: English. Docs in `docs/`: Russian.
- User-visible strings (review UI, business labels) are localized (ru/en); AI prompts are per language and the AI answers in the configured language.
- Update `docs/` in the same change as the behaviour it describes.
