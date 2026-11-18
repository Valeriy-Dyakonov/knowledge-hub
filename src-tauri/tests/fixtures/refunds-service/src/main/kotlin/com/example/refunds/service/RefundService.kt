package com.example.refunds.service

import com.example.refunds.client.PaymentsClient
import com.example.refunds.client.Reservation
import com.example.refunds.domain.CreateRefund
import com.example.refunds.domain.Refund
import com.example.refunds.domain.RefundCreated
import com.example.refunds.persistence.RefundEntity
import com.example.refunds.persistence.RefundRepository
import org.springframework.context.ApplicationEventPublisher
import org.springframework.stereotype.Service
import java.util.UUID

@Service
class RefundService(
    private val repository: RefundRepository,
    private val paymentsClient: PaymentsClient,
    private val events: ApplicationEventPublisher,
) {
    fun create(request: CreateRefund): Refund {
        val entity = repository.save(RefundEntity(UUID.randomUUID(), request.amount, "NEW"))
        paymentsClient.reserve(Reservation(entity.id, request.amount))
        events.publishEvent(RefundCreated(entity.id))
        return toRefund(entity)
    }

    fun get(id: UUID): Refund = toRefund(repository.findById(id).orElseThrow())

    fun markPaid(id: UUID) {
        val entity = repository.findById(id).orElseThrow()
        entity.status = "PAID"
        repository.save(entity)
    }

    private fun toRefund(e: RefundEntity) = Refund(e.id, e.amount, e.status)
}
