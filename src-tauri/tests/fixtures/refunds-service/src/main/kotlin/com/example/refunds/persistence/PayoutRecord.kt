package com.example.refunds.persistence

import org.springframework.data.annotation.Id
import org.springframework.data.relational.core.mapping.Column
import org.springframework.data.relational.core.mapping.Table
import org.springframework.data.repository.CrudRepository
import java.util.UUID

/** Spring Data JDBC: `@Table` without `@Entity`. */
@Table("payouts")
data class PayoutRecord(
    @Id val id: Long,
    @Column("refund_id") val refundId: UUID,
    val amountCents: Long,
)

interface PayoutRepository : CrudRepository<PayoutRecord, Long>
