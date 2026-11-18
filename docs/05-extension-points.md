# 05. Точки расширения

Каждая ось — интерфейс (TypeScript в `src/lib/`) или трейт (Rust в `src-tauri/src/`). Реализации регистрируются в реестре — массиве или списке, который перебирают потребители. Выбор и порядок — через `supports(...)`/`enabled(...)` и настройки. Паттерн тот же, что `SourceCollector` + `COLLECT_STEPS` в worklog-tracker.

## Таблица осей

| Ось | Интерфейс | Где | Первая реализация | Позже |
|---|---|---|---|---|
| Язык анализируемого кода | `Extractor` | Rust `extract/` | Kotlin + Spring Boot (tree-sitter) | Java, TypeScript, Python |
| Доп. источники | `ContextSource` | Rust `context/` | `application.yml`, OpenAPI, миграции, CODEOWNERS | Jira, Confluence, runtime-маппинги |
| ИИ | LLM-клиент | Rust `llm.rs` | OpenAI-совместимый шлюз | локальная модель |
| Хранилище знаний | `KnowledgeStore` | Rust `store/` | локальная папка (YAML) | git-репозиторий, GitLab |
| Индекс | `Indexer` | Rust `index/` | SQLite FTS5 | вектор, граф |
| Представления | `Renderer` | TS `lib/render/` | markdown, Mermaid L1–L3 | D2, C4, PDF |
| Ревью | `ReviewPolicy` | TS `lib/review/` | строгая | мягкая |
| Отдача | MCP-инструмент | Rust `mcp/` | 7 инструментов из `08-mcp.md` | REST, экспорт |
| Стадии | `Stage` | TS `lib/stages/` | 7 стадий из `03-pipeline.md` | дополнительные |

## Эскизы интерфейсов

```rust
// src-tauri/src/extract/mod.rs
pub trait Extractor: Send + Sync {
    fn id(&self) -> &'static str;
    fn version(&self) -> &'static str;
    fn supports(&self, repo: &RepoSnapshot) -> bool;
    fn extract(&self, repo: &RepoSnapshot) -> Result<SourceFacts, AppError>; // facts with Evidence only
}

// src-tauri/src/context/mod.rs
pub trait ContextSource: Send + Sync {
    fn id(&self) -> &'static str;
    fn required(&self) -> bool { false }
    fn collect(&self, repo: &RepoSnapshot) -> Result<ContextFacts, AppError>;
}

pub trait KnowledgeStore {
    fn load(&self, service: &str) -> Result<Option<KnowledgeModel>, AppError>;
    fn save(&self, service: &str, model: &KnowledgeModel) -> Result<(), AppError>;
    fn history(&self, service: &str, feature: &str) -> Result<Vec<ModelRevision>, AppError>;
    fn write_generated(&self, service: &str, files: &[GeneratedFile]) -> Result<(), AppError>;
}

pub trait Indexer {
    fn index(&self, model: &KnowledgeModel) -> Result<(), AppError>;
    fn search(&self, query: &SearchQuery) -> Result<Vec<SearchHit>, AppError>;
}
```

```ts
// src/lib/stages/types.ts
interface Stage {
  id: string;
  required: boolean;
  skipReason?(ctx: RunContext): string | null;
  run(ctx: RunContext): Promise<void>;
}

// src/lib/render/types.ts — never reads the repository, never calls the LLM
interface Renderer {
  id: string;
  render(model: KnowledgeModel, view: ViewSpec): GeneratedFile[];
}

// src/lib/review/types.ts
interface ReviewPolicy {
  id: string;
  selectForReview(sel: ReviewSelection): ReviewBatch[];
  canClose(batch: ReviewBatch, answers: ReviewAnswer[]): CloseDecision;
}
```

Эскизы ориентировочные; точные сигнатуры — в коде вместе с контрактными тестами.

## Принципы расширяемости

- **Реестр вместо `switch`/`match`.** Новый вариант — новый модуль и запись в реестре, а не новая ветка в существующем коде.
- **Нет знания о реализациях в ядре.** Пайплайн работает только с интерфейсами.
- **Общая политика ошибок.** Включение, обязательность и обработка сбоя — в одном месте (`lib/steps.ts`).
- **Контрактные тесты на интерфейс.** Любая реализация обязана их проходить.
- **Настройки, а не код.** Включить/выключить реализацию — настройкой.

## Чеклисты

Полные чеклисты («новый экстрактор», «новый рендерер» и т.д.) — в `AGENTS.md`. При добавлении новой оси обновлять и таблицу выше, и `AGENTS.md`.
