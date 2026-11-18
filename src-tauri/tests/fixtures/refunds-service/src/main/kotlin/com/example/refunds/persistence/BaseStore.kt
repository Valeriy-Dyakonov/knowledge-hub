package com.example.refunds.persistence

import kotlinx.coroutines.reactor.awaitSingle
import org.springframework.data.r2dbc.core.R2dbcEntityTemplate
import org.springframework.data.relational.core.query.Query
import org.springframework.stereotype.Repository
import kotlin.reflect.KClass

/** Generic store over the R2DBC template: the entity type is bound by each subclass. */
abstract class BaseStore<E : Any, K : Any>(
    protected val template: R2dbcEntityTemplate,
    protected val entityType: KClass<E>,
) {
    open suspend fun insert(entity: E): E = template.insert(entity).awaitSingle()

    open suspend fun remove(entity: E): E = template.delete(entity).awaitSingle()

    suspend fun all(): List<E> = template.select(Query.empty(), entityType.java).collectList().awaitSingle()
}

@Repository
class PayoutStore(template: R2dbcEntityTemplate) : BaseStore<PayoutRecord, Long>(template, PayoutRecord::class) {
    suspend fun latest(): PayoutRecord? = all().lastOrNull()
}
