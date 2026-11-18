package com.example.refunds.persistence

import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Query
import java.util.UUID

interface RefundRepository : JpaRepository<RefundEntity, UUID> {
    fun findAllByStatus(status: String): List<RefundEntity>

    // JPQL with a second entity: its table is read too.
    @Query("select r from RefundEntity r join RefundItemEntity i on i.refund = r where i.stockKeepingUnit = :sku")
    fun findBySku(sku: String): List<RefundEntity>
}
