# 08. MCP

Harness получает знания по MCP и ничего не знает о внутренностях хаба. MCP-сервер — тот же исполняемый файл приложения, запущенный с аргументом `mcp`: окно не открывается, сервер работает по stdio и читает папку знаний и индекс из настроек. Пример конфигурации harness:

```json
{ "mcpServers": { "knowledge-hub": { "command": "C:/Program Files/Knowledge Hub/knowledge-hub.exe", "args": ["mcp"] } } }
```

## Инструменты (первая версия)

| Инструмент | Назначение |
|---|---|
| `list_features(service?)` | список фич: id, бизнес-название, одна строка, статус ревью |
| `get_feature(id, depth)` | описание фичи; `depth`: `summary` / `flow` / `full` |
| `get_flow(id)` | поток от триггера до стоков (шаги с evidence) |
| `get_diagram(id\|level, format)` | диаграмма (Mermaid или SVG) |
| `search(query, limit)` | поиск по знаниям (FTS, позже гибридный) |
| `who_touches(sink)` | какие фичи пишут/читают таблицу, топик или внешний сервис |
| `freshness(id?)` | статус ревью, коммит подтверждения, причины устаревания |

Принцип progressive disclosure: сначала короткий индекс (`list_features`, `search`), детали по запросу (`get_feature`, `get_flow`). Структурные запросы (`who_touches`) идут по модели, а не по векторам.

## Формат ответа

Каждый ответ содержит данные и метаданные доверия:

```json
{
  "data": { },
  "meta": {
    "reviewStatus": "REVIEWED | DRAFT | STALE",
    "verifiedAtCommit": "abc1234",
    "reviewedAt": "2026-11-18T10:00:00Z",
    "staleReasons": ["src/.../RefundService.kt changed"],
    "unverifiedClaims": 3
  }
}
```

Агент должен видеть, чему можно верить, а что требует проверки по коду.

## Ошибки

Коды, а не проза: `featureNotFound`, `serviceNotIndexed`, `indexUnavailable`. Текст формирует клиент.

## Реализация (M6)

- `src-tauri/src/mcp/tools.rs` — семь инструментов над папкой знаний и индексом; `stdio.rs` — JSON-RPC 2.0 построчно (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`). Ответ инструмента — в `structuredContent` и тем же JSON в `content[0].text`; ошибка — `isError: true` и `{ "error": { "code", "params" } }`.
- Запуск: `knowledge-hub.exe mcp [--knowledge-dir <путь>]`. Без `--knowledge-dir` берётся папка знаний из настроек приложения. Готовый фрагмент конфигурации — в приложении: Настройки → «MCP для агентов».
- `service` во всех инструментах необязателен: без него `list_features`, `search`, `who_touches`, `freshness` работают по всем сервисам папки, а `get_feature`/`get_flow` ищут фичу во всех.
- `who_touches(sink)` ищет сток по id (`topic:refunds.created`), техническому имени (`refunds`) или бизнес-названию; отклонённые связи не учитываются.
- `meta`: `reviewStatus` по claims ответа, `verifiedAtCommit` и `reviewedAt` — самого позднего решения ревью, `staleReasons`, `unverifiedClaims`.
- Поиск — SQLite FTS5 (`.state/index.db`, токенизатор unicode61: русский и английский, поиск по префиксу). Индекс перестраивается стадией Index и после каждой закрытой пачки ревью.

## Права

Только чтение. MCP не запускает анализ и не меняет знания; запуск анализа и ревью — в приложении.

## Реализация

Rust, `src-tauri/src/mcp/`: JSON-RPC по stdio (`initialize`, `tools/list`, `tools/call`, `ping`), реализован вручную — протокол небольшой, а зависимостей меньше. Код инструментов (`mcp/tools.rs`) отделён от транспорта (`mcp/stdio.rs`), так что HTTP-транспорт добавляется без изменения инструментов.
