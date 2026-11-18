package com.example.refunds.persistence

import jakarta.persistence.Entity
import jakarta.persistence.Id
import jakarta.persistence.Table
import java.math.BigDecimal
import java.util.UUID

@Entity
@Table(name = "refunds")
class RefundEntity(
    @Id val id: UUID,
    val amount: BigDecimal,
    var status: String,
)
