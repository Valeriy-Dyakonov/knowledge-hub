# 08. MCP

Хаб — отдельный сервис; harness получает знания по MCP и ничего не знает о внутренностях. MCP — одна из реализаций `KnowledgeEndpoint`.

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

## Права

Только чтение. MCP не запускает анализ и не меняет знания; запуск анализа и ревью — через CLI/UI хаба.

## Реализация

Spring AI MCP server либо официальный Kotlin SDK — выбрать при старте M5 после короткого сравнения; код инструментов отделён от транспорта.
