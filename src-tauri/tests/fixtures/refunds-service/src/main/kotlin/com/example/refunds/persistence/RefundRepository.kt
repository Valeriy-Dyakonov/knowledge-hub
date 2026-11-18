package com.example.refunds.persistence

import org.springframework.data.jpa.repository.JpaRepository
import java.util.UUID

interface RefundRepository : JpaRepository<RefundEntity, UUID> {
    fun findAllByStatus(status: String): List<RefundEntity>
}
