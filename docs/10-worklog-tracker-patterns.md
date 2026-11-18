# 10. Что переносим из worklog-tracker

Проект `worklog-tracker` (Tauri + React/TypeScript + Rust) задаёт стиль, которому следует хаб. Разобраны `AGENTS.md`, README, `pipeline.ts`, `sources/types.ts`, `analysis/steps.ts`, `analysis/types.ts`, `sources/llm.rs`.

| В worklog-tracker | В хабе |
|---|---|
| `runAnalysis()` только оркестрирует стадии | `AnalysisPipeline` в `kb-pipeline` |
| `RunContext` — общее состояние запуска | `RunContext` (+ id запуска, коммит, версии) |
| `SourceCollector` (Strategy) и реестр `COLLECT_STEPS` | `Extractor`/`ContextSource` и `List<Port>` в Spring |
| `sourceStep`: единая политика skip/required/warning | та же политика на шаги и источники |
| `HeuristicAllocator` / `AiAllocator`, откат на эвристику | статический анализ как база, LLM как улучшение |
| `Evidence`, `toEvidence` | `Evidence` у каждого claim |
| `AppError { code, params }`, текст на фронте | `HubError(code, params)`, текст в UI/i18n |
| i18n: ru/en, ключи в обеих локалях, промпты по языкам | то же для UI ревью, бизнес-названий, промптов |
| Чеклисты в `AGENTS.md` («New data source» и т.д.) | чеклисты расширения в `AGENTS.md` |
| «Все подключения только чтение» | хаб только читает анализируемые репозитории |
| OpenAI-совместимый клиент, повтор без `response_format` | `LlmClient` с тем же поведением |
| Настройки отдельно от секретов (keyring) | секреты вне файлов знаний и логов |
| «Реестр/стратегия, а не растущий switch» | правило в `AGENTS.md` |
| `InfoTip` у неочевидных элементов UI | то же в UI ревью |

## Отличия

- Запуски долгие и персистентные (возобновление), а не in-memory.
- Результат — проверенная база знаний с жизненным циклом claims, а не одноразовый отчёт.
- Бэкенд на Kotlin/Spring (нет разделения «Rust-бэкенд + TS-логика»): логика пайплайна живёт на сервере.
