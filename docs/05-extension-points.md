# 05. Точки расширения (SPI)

Каждая ось — интерфейс в `kb-ports`. Реализации регистрируются как Spring-бины; потребители получают `List<Port>`. Выбор и порядок — через `supports(...)`/`@Order` и конфигурацию. Паттерн тот же, что `SourceCollector` + `COLLECT_STEPS` в worklog-tracker.

## Таблица осей

| Ось | Порт | Первая реализация | Позже |
|---|---|---|---|
| Язык/стек | `Extractor` | Kotlin + Spring Boot | Java, TypeScript, Python |
| Доп. источники | `ContextSource` | OpenAPI, миграции, `application.yml` | Jira, Confluence, runtime-маппинги |
| ИИ | `LlmClient` | OpenAI-совместимый шлюз | локальная модель |
| Хранилище знаний | `KnowledgeStore` | локальная папка | git-репозиторий, GitLab |
| Индекс | `Indexer` | SQLite FTS5 | вектор, граф |
| Представления | `Renderer` | markdown, Mermaid | D2, C4, PDF |
| Ревью | `ReviewPolicy` | строгая | мягкая |
| Отдача | `KnowledgeEndpoint` | MCP | REST, экспорт |
| Стадии | `Stage` | 7 стадий из `03-pipeline.md` | дополнительные |

## Эскизы интерфейсов

```kotlin
interface Extractor {
    val id: String
    fun supports(repo: RepoSnapshot): Boolean
    suspend fun extract(repo: RepoSnapshot, ctx: RunContext): ExtractionResult  // facts with Evidence only
}

interface ContextSource {
    val id: String
    fun enabled(ctx: RunContext): Boolean
    val required: Boolean get() = false
    suspend fun collect(ctx: RunContext): ContextFacts
}

interface LlmClient {
    suspend fun complete(request: LlmRequest): LlmResponse   // JSON mode with fallback, retries
}

interface KnowledgeStore {
    fun load(service: ServiceId): KnowledgeModel?
    fun save(service: ServiceId, model: KnowledgeModel)
    fun history(service: ServiceId, feature: FeatureId): List<ModelRevision>
}

interface Indexer {
    fun index(model: KnowledgeModel)
    fun search(query: SearchQuery): List<SearchHit>
}

interface Renderer {
    val id: String
    fun render(model: KnowledgeModel, view: ViewSpec): List<RenderedFile>
}

interface ReviewPolicy {
    fun selectForReview(claims: List<Claim>): List<ReviewBatch>
    fun canClose(batch: ReviewBatch, answers: List<ReviewAnswer>): CloseDecision
}

interface Stage {
    val title: String
    suspend fun run(ctx: RunContext)
}
```

Эскизы ориентировочные; точные сигнатуры фиксируются в M1 вместе с контрактными тестами.

## Принципы расширяемости

- **Реестр вместо `when`.** Новый вариант — новый класс, а не новая ветка в существующем коде.
- **Нет знания о реализациях в ядре.** Пайплайн работает только с портами.
- **Общая политика ошибок.** Включение, обязательность и обработка сбоя — в одном месте.
- **Контрактные тесты на порт.** Любая реализация обязана их проходить.
- **Конфигурация, а не код.** Включить/выключить реализацию — настройкой.

## Чеклисты

Полные чеклисты («новый экстрактор», «новый рендерер» и т.д.) — в `AGENTS.md`. При добавлении новой оси обновлять и таблицу выше, и `AGENTS.md`.
