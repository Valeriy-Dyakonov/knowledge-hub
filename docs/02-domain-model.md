# 02. Доменная модель

Модель хранится структурно (YAML/JSON в `KnowledgeStore`). Всё остальное — представления.

## Сущности

| Сущность | Смысл |
|---|---|
| `Service` | анализируемый сервис: имя, репозиторий, ветка, стек |
| `Feature` | функциональность с точки зрения продукта: `refunds/create`, `auth/refresh-token` |
| `Trigger` | что запускает фичу: HTTP-эндпоинт, сообщение из очереди, расписание, событие, CLI |
| `Component` | узел реализации: controller, service, repository, client, publisher, listener |
| `Step` | упорядоченный шаг потока: компонент + действие |
| `Sink` | конечная точка: таблица БД, топик/очередь, внешний HTTP API, файл |
| `Edge` | связь между узлами потока: CALL, READ, WRITE, PUBLISH, CONSUME, HTTP_CALL |
| `Claim` | единица ревью: утверждение о любой сущности выше |
| `Evidence` | доказательство: где в коде это видно |

## Claim

Каждый факт модели оборачивается в claim, потому что именно claim ревьюится.

```kotlin
data class Claim(
    val id: ClaimId,                 // stable across re-runs (hash of subject + kind + key evidence)
    val subject: SubjectRef,         // Feature / Trigger / Step / Edge / Sink ...
    val kind: ClaimKind,             // EXISTS, BELONGS_TO_FEATURE, WRITES_TO, CALLS, DESCRIBES, ...
    val payload: ClaimPayload,       // structured value
    val evidence: List<Evidence>,
    val origin: Origin,              // STATIC, INFERRED, HUMAN
    val confidence: Confidence,      // HIGH / MEDIUM / LOW
    val status: ClaimStatus,         // PROPOSED, CONFIRMED, EDITED, REJECTED, STALE
    val review: ReviewInfo?,         // who, when, comment
    val verifiedAt: CommitRef?,      // commit at which it was last confirmed
)

data class Evidence(
    val repo: String,
    val path: String,
    val lines: IntRange?,
    val commit: String,
    val fingerprint: String,         // hash of the referenced fragment, used for staleness
)
```

### Origin и confidence

- `STATIC` — получено статическим анализом (аннотации, сигнатуры, конфиги). Confidence обычно HIGH; на ревью попадает выборочно.
- `INFERRED` — вывод LLM или эвристики (например, связь через DI или событие). Всегда ревьюится; confidence ограничен сверху.
- `HUMAN` — введено или исправлено человеком; не перезаписывается повторным анализом без явного конфликта.

### Статусы

`PROPOSED -> CONFIRMED | EDITED | REJECTED`. `CONFIRMED/EDITED -> STALE`, когда fingerprint evidence перестал совпадать с кодом. `REJECTED` запоминается, чтобы анализ не предлагал то же снова.

### Стабильные идентификаторы

Идентификатор claim не должен меняться при повторном анализе, иначе ревью потеряется. Он строится из типа, субъекта и ключевых признаков (например, `POST /refunds` + имя метода), а не из номеров строк.

## Двойные названия

У `Feature`, `Component`, `Sink` есть `technicalName` и `businessName` (локализуемое, ru/en). Диаграммы для нетехнических читателей используют `businessName`. Бизнес-название — отдельный claim (`DESCRIBES`) и тоже ревьюится.

## Версионирование схемы

`schemaVersion` в `service.yaml`. Миграции модели — отдельный механизм; без обратно-совместимого чтения старой схемы формат на диске не менять.
