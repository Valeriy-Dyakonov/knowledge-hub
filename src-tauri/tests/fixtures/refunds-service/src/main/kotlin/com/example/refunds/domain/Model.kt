package com.example.refunds.domain

import java.math.BigDecimal
import java.util.UUID

data class CreateRefund(val amount: BigDecimal)

data class Refund(val id: UUID, val amount: BigDecimal, val status: String)

data class RefundCreated(val id: UUID)

object Topics {
    const val APPROVED = "refunds.approved"
}
