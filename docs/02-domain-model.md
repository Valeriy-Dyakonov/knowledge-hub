# 02. Доменная модель

Модель хранится структурно (YAML в `KnowledgeStore`). Всё остальное — представления. Типы описаны в `src/types.ts` и зеркально в Rust (`src-tauri/src/model/`), как `Settings` в worklog-tracker.

## Сущности

| Сущность | Смысл |
|---|---|
| `Service` | анализируемый сервис: имя, репозиторий, ветка, стек |
| `Feature` | функциональность с точки зрения продукта: `refunds/create`, `auth/refresh-token` |
| `Trigger` | что запускает фичу: HTTP-эндпоинт, сообщение из очереди, расписание, событие, запуск сервиса, `@Async`-метод без вызовов в проекте, CLI |
| `Component` | узел реализации: controller, service, repository, client, publisher, listener |
| `Step` | упорядоченный шаг потока: компонент + действие |
| `Sink` | конечная точка: таблица БД, топик/очередь, внешний HTTP API, файл |
| `Edge` | связь между узлами потока: CALL, READ, WRITE, PUBLISH, CONSUME, HTTP_CALL |
| `Claim` | единица ревью: утверждение о любой сущности выше |
| `Evidence` | доказательство: где в коде это видно |

## Claim

Каждый факт модели оборачивается в claim, потому что именно claim ревьюится.

```ts
// src/types.ts (mirrored by src-tauri/src/model/)
type Claim = {
  id: ClaimId;                  // stable across re-runs (hash of scope + kind + subject + key)
  featureId: FeatureId | null;  // null for service-level claims (catalog names)
  subject: SubjectRef;          // Feature / Trigger / Step / Edge / Sink ...
  kind: ClaimKind;              // EXISTS, BELONGS_TO_FEATURE, WRITES_TO, CALLS, DESCRIBES, ...
  payload: Record<string, string>; // structured value
  evidence: Evidence[];
  origin: Origin;               // STATIC, INFERRED, HUMAN
  confidence: Confidence;       // HIGH / MEDIUM / LOW
  status: ClaimStatus;          // PROPOSED, CONFIRMED, EDITED, REJECTED, STALE
  review?: ReviewInfo;          // who, when, comment
  verifiedAt?: string;          // commit at which it was last confirmed
};

type Evidence = {
  repo: string;
  path: string;
  lines?: { start: number; end: number };
  commit: string;
  fingerprint: string;          // hash of the referenced fragment, used for staleness
};
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

## База данных и конфигурация

Справочные факты рядом с фичами (`database` и `config` в модели, файлы `database.yaml` и `config.yaml`). Это не claims: они получены детерминированно, у каждого есть evidence, и по одному они не ревьюятся; в MCP идут с `reviewStatus = STATIC`.

- **Хранилище** (`TableInfo.store`): `sql`, `mongo`, `redis`, `elasticsearch`, `cassandra`, `neo4j` или `unknown`. Класс считается хранимым по аннотации: `@Entity`, `@Table` (Spring Data JDBC/R2DBC; Cassandra — по импорту), `@Document` (MongoDB; Elasticsearch — при `indexName` или по импорту), `@RedisHash`, `@Node`; а также если он — тип Spring Data репозитория (`JpaRepository<X, …>`, `MongoRepository`, `CrudRepository`…), даже без аннотации: тогда хранилище — по типу репозитория. Имена по умолчанию — как у Spring Data: SQL — `snake_case`, MongoDB — `lowerCamel`, Redis — полное имя класса. Поля не-SQL хранилищ — как в коде (`@Field`, `@Column`, `@Property` переопределяют), у MongoDB `@Id` — `_id`. ER-диаграмма строится только для SQL.
- **Таблица** (`TableInfo`): колонки (тип, nullable, PK, FK), JPA-сущность и поле для колонки, источник структуры: `migration` (Flyway SQL / Liquibase YAML/XML, применяются по порядку версий: create, alter add/drop/rename column, add constraint, rename table, drop), `entity` (только `@Entity`/`@Document`: `@Table`, `@Column`, `@JoinColumn`, `@Id`, `@ManyToOne`/`@OneToOne`), `both`, `code` (таблица видна только в репозитории/запросе). Какие фичи читают и пишут таблицу — из рёбер потоков к стоку `db_table:<имя>`.
- **Обращения в коде** (`TableInfo.accesses`): все места, которые читают или пишут таблицу, — методы репозиториев, JdbcTemplate, таблицы из `@Query` (JPQL: имена сущностей переводятся в таблицы, `nativeQuery` — как SQL) и неявная запись: в `@Transactional` (не `readOnly`) методе JPA-сущность, загруженная через репозиторий, меняется (`e.status = …`) без `save` — это запись при коммите (`INFERRED`, на ревью). Список не зависит от фич: таблица без фич, но с обращениями значит, что вызывающий код не достижим из точек входа.
- **Источник данных** (`Datasource`): `*.datasource.url`, `r2dbc.url`, `mongodb.uri`, `flyway/liquibase.url`, Redis (`*.redis.url` или `host`/`port`), `elasticsearch.uris`, `cassandra.contact-points` в базе и в профилях; хранится без логина и пароля.
- **Свойство** (`ConfigProperty`): значение без профиля, значения по профилям (`application-<p>.yml`, документы с `spring.config.activate.on-profile`), где задано, кто читает: `@Value`, плейсхолдеры в аннотациях (`@Scheduled`, `@KafkaListener`...), `Environment.getProperty`, `@ConfigurationProperties(prefix)` (чтение префикса прикрепляется ко всем свойствам под ним). Секреты маскируются (`***`). `missing` — код читает, но значения нет нигде и нет default: должно прийти из окружения.

## Версионирование схемы

`schemaVersion` в `service.yaml`. Миграции модели — отдельный механизм; без обратно-совместимого чтения старой схемы формат на диске не менять.
