package com.example.refunds.persistence

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.Id
import jakarta.persistence.JoinColumn
import jakarta.persistence.ManyToOne
import jakarta.persistence.Table

@Entity
@Table(name = "refund_items")
class RefundItemEntity(
    @Id val id: Long,
    @ManyToOne
    @JoinColumn(name = "refund_id")
    val refund: RefundEntity,
    @Column(name = "sku") val stockKeepingUnit: String,
    val quantity: Int,
    val comment: String?,
)
