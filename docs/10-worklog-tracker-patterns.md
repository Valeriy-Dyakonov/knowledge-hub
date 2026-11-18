# 10. Что переносим из worklog-tracker

Проект `worklog-tracker` (Tauri 2 + React/TypeScript + Rust) задаёт и стек, и стиль хаба: хаб — такое же десктоп-приложение. Разобраны `AGENTS.md`, README, `pipeline.ts`, `sources/types.ts`, `analysis/steps.ts`, `analysis/types.ts`, `sources/llm.rs`.

| В worklog-tracker | В хабе |
|---|---|
| Tauri 2 + React/TS + Rust | то же |
| `runAnalysis()` только оркестрирует стадии | `runAnalysis()` в `src/lib/pipeline.ts` |
| `RunContext` — общее состояние запуска | `RunContext` (+ id запуска, коммит, версии, чекпойнты) |
| `SourceCollector` (Strategy) и реестр `COLLECT_STEPS` | `Stage` + `STAGES`; в Rust трейты `Extractor`/`ContextSource` и их реестры |
| `sourceStep`: единая политика skip/required/warning | `lib/steps.ts`: та же политика на стадии, рендереры, индексы |
| `HeuristicAllocator` / `AiAllocator`, откат на эвристику | статический анализ как база, LLM как улучшение |
| `Evidence`, `toEvidence` | `Evidence` у каждого claim |
| `AppError { code, params }`, текст на фронте | то же |
| `api.ts` — единственное место с `invoke` | то же |
| i18n: ru/en, ключи в обеих локалях, промпты по языкам | то же для UI, бизнес-названий, промптов |
| Чеклисты в `AGENTS.md` («New data source» и т.д.) | чеклисты расширения в `AGENTS.md` |
| «Все подключения только чтение» | хаб только читает анализируемые репозитории |
| OpenAI-совместимый клиент, повтор без `response_format` | `llm.rs` с тем же поведением |
| `settings.json` отдельно от секретов (keyring) | то же |
| UI kit (`components/ui`), темы и токены в `styles/` | то же |
| «Реестр/стратегия, а не растущий switch» | правило в `AGENTS.md` |
| `InfoTip` у неочевидных элементов UI | то же |

## Отличия

- Запуски долгие и персистентные (чекпойнты в SQLite, возобновление), а не in-memory.
- Результат — проверенная база знаний с жизненным циклом claims на диске, а не одноразовый отчёт.
- Тот же исполняемый файл работает как MCP-сервер без окна (аргумент `mcp`).
- Разбор кода (tree-sitter) и индекс (SQLite FTS5) — в Rust.
