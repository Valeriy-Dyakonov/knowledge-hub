# Knowledge Hub — notes for agents and contributors

Desktop app (Tauri 2 + React/TypeScript, Rust backend — same stack and rules as worklog-tracker) that analyses a source repository, splits it into **features**, traces each process from its trigger to the sink (database, queue, external service), and stores the result as a **human-reviewed knowledge base**. Pick a repository, run the analysis, browse features, flows and diagrams, review claims — all in one window. Harnesses/agents consume the knowledge through **MCP**: the same executable started with the `mcp` argument (no window, stdio).

Kotlin + Spring Boot is the first stack of **analysed** repositories, not the hub's own stack.

Design docs live in `docs/` (Russian); read `docs/00-vision.md` and `docs/01-architecture.md` first. Milestones: `docs/09-roadmap.md`. Do not add CI/GitLab triggers, webhooks or auto-update on merge — out of scope for now.

## Commands

| What | Command (repo root unless noted) |
|---|---|
| Dev app | `npm run tauri dev` |
| Typecheck | `npx tsc --noEmit -p .` |
| Frontend tests | `npm test` (vitest, `src/**/*.test.ts`) |
| Frontend build | `npx vite build` |
| Rust tests | `cargo test` in `src-tauri/` |
| Regenerate golden files | `UPDATE_GOLDEN=1 cargo test` in `src-tauri/` (scan facts, scan JSON), then `UPDATE_GOLDEN=1 npm test` (features, model JSON); review the diffs |
| Print the tree-sitter tree of a Kotlin file | `cargo run --example sexp -- File.kt` in `src-tauri/` |

On this Windows machine cargo may be missing from PATH in Git Bash: prefix with `PATH="$HOME/.cargo/bin:$PATH"`.
Before committing, run typecheck + `npm test` + `vite build`, and the Rust tests if `src-tauri` changed.

## Layout

### Frontend `src/`
- `api.ts` — the only place that calls Tauri `invoke`; one function per Rust command.
- `types.ts` — domain model and settings (`Service`, `Feature`, `Trigger`, `Component`, `Step`, `Sink`, `Edge`, `Claim`, `Evidence`, `ReviewItem`, `Settings`...). Must mirror `src-tauri/src/model/` and `settings.rs`.
- `i18n/` — `locale.ts`, `format.ts`, `index.ts` (`useT()`/`t()`), `messages/{ru,en}/<namespace>.ts`.
- `lib/` — pure logic, no React:
  - `pipeline.ts` — `runAnalysis()`: orchestrates stages only; checkpoints after each stage.
  - `steps.ts` — the single skip/required/warning policy.
  - `stages/` — one file per stage (`scan`, `discover`, `trace`, `describe`, `assemble`, `render`, `index`), registry `STAGES`.
  - `model/` — `ids.ts` (stable ids), `claims.ts` (claim creation and review transitions), `merge.ts` (merge with the previous model + projection of names), `placeholders.ts`, `status.ts`.
  - `review/` — `ReviewPolicy` implementations (strict, lenient), registry, review use-cases.
  - `render/` — `Renderer`s (markdown, Mermaid L1–L3), registry `RENDERERS`.
  - `prompt.ts` — LLM prompts per language.
- `components/` — `ui/` (kit), one folder per screen: `repos/`, `run/`, `features/`, `diagrams/`, `review/`, `settings/`.
- `styles/` — all CSS; colors only in `tokens.css`/`themes.css`.

### Backend `src-tauri/src/`
- `lib.rs` — module list and `run()` only; `main.rs` — starts the UI, or the MCP server when the first argument is `mcp`.
- `error.rs` — `AppError { code, params }`; never return user-facing prose.
- `model/` — serde mirror of `src/types.ts`.
- `repo.rs` — read-only repository snapshot (file listing, reads inside the root only, commit from `.git`).
- `extract/` — `Extractor` trait + registry; `extract/kotlin_spring/` — tree-sitter based extractor: `syntax.rs` (tree -> small Kotlin model), `spring.rs` (Spring semantics -> facts), `golden.rs` (golden test over `tests/fixtures/refunds-service`).
- `context/` — `ContextSource` trait + registry (`spring_config`, `openapi`, `migrations`, `codeowners`).
- `redact.rs` — secret masking for configuration values and any text sent to the LLM or stored.
- `store/` — `KnowledgeStore` on a local folder (`docs/07-storage.md`).
- `state.rs` — SQLite in `.state/hub.db`: runs, checkpoints, logs, review batches, answers, journal, questions.
- `index/` — `Indexer` on SQLite FTS5 (`.state/index.db`).
- `llm.rs` — OpenAI-compatible client. `secrets.rs` — keyring. `settings.rs` — `settings.json`.
- `mcp/` — `stdio.rs` (transport), `tools.rs` (tool logic, standard envelope).
- `commands/` — Tauri commands grouped by area.

## Checklists

**New extractor** (another language/framework of analysed code):
1. Module `src-tauri/src/extract/<name>/` implementing `Extractor`; `supports(repo)` decides applicability.
2. Emit only facts with `Evidence` (path, lines, commit, fingerprint). Anything guessed is `origin = INFERRED` with a confidence.
3. Add it to the registry in `extract/mod.rs`; no change to the pipeline.
4. Fixture repo in `src-tauri/tests/fixtures/` + golden test of extracted entry points/sinks.

**New context source** (OpenAPI, migrations, Jira, runtime mappings): implement `ContextSource` in `context/`, add to the registry, same evidence rules.

**New stage**: file in `lib/stages/`, add to `STAGES` with its order; must be idempotent (state comes from `RunState`, result goes back into it).

**New renderer**: implement `Renderer` in `lib/render/`, add to `RENDERERS`. Never read the repository, never call the LLM; output starts with the generated header.

**New review rule**: implement `ReviewPolicy` (or a rule inside it) in `lib/review/`; document in `docs/04-review.md`.

**New store / index / LLM adapter**: implement the trait in its own Rust module; contract tests next to the trait.

**New MCP tool**: add to `mcp/tools.rs`; response uses the standard envelope (`docs/08-mcp.md`) with review status and verified commit.

**New setting**: `settings.rs` + `types.ts` (same camelCase name, default in both) + settings UI + texts in `messages/{ru,en}/settings.ts`.

## Contracts that must not break
- The on-disk knowledge layout and the model schema version (`schemaVersion` in `service.yaml`).
- MCP tool names, arguments and the response envelope.
- Claim and evidence identifiers (stable across re-runs, so reviews survive re-analysis).
- Tauri command names, arguments and returned JSON shapes (see `api.ts`); `settings.json` format and keyring entry names.

## Rules
- **Read-only toward analysed repositories.** The hub never writes to them.
- **Every claim has evidence.** No evidence -> `origin = INFERRED`, low confidence, goes to review first.
- **Deterministic first, LLM second.** Static facts are the baseline; if the LLM fails, the run still produces the static model (like `HeuristicAllocator` fallback in worklog-tracker).
- **Views are generated.** Markdown and diagrams come from the model through `Renderer`s; do not hand-edit generated files (they carry a header saying so).
- **No bulk approval.** Review actions are per claim/diff; see `docs/04-review.md`. Do not add "approve all".
- **Errors are codes.** `AppError { code, params }`; user-facing text comes from i18n.
- **Secrets never leave the process.** Redact tokens/keys before anything goes to the LLM or the store; tokens live in keyring.
- **Reviewed vs pending is explicit.** Anything shown in the app or served over MCP carries its review status.

## Localization
- No user-visible string literals in components or `lib/`: keys in **both** `messages/ru` and `messages/en` (en typed `typeof ru`).
- AI prompts are per language; the AI answers in the configured language.

## Conventions
- Small focused modules; prefer a registry/strategy over a growing `switch`/`match`.
- Comments only for a non-obvious "why".
- Code, comments, commit messages: English. Docs in `docs/`: Russian.
- Anything whose purpose isn't obvious in the UI gets an `InfoTip`.
- Update `docs/` in the same change as the behaviour it describes.
