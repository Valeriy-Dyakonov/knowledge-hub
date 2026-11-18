package com.example.refunds.service

import com.example.refunds.client.PaymentsClient
import com.example.refunds.client.Reservation
import com.example.refunds.domain.CreateRefund
import com.example.refunds.domain.Refund
import com.example.refunds.domain.RefundCreated
import com.example.refunds.notify.NotificationService
import com.example.refunds.persistence.RefundEntity
import com.example.refunds.persistence.RefundLock
import com.example.refunds.persistence.RefundLockRepository
import com.example.refunds.persistence.RefundRepository
import org.springframework.context.ApplicationEventPublisher
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.util.UUID

@Service
class RefundService(
    private val repository: RefundRepository,
    private val paymentsClient: PaymentsClient,
    private val events: ApplicationEventPublisher,
    private val notifications: NotificationService,
    private val locks: RefundLockRepository,
) {
    fun create(request: CreateRefund): Refund {
        val entity = repository.save(RefundEntity(UUID.randomUUID(), request.amount, "NEW"))
        paymentsClient.reserve(Reservation(entity.id, request.amount))
        events.publishEvent(RefundCreated(entity.id))
        notifications.notifyCustomer(entity.id)
        return toRefund(entity)
    }

    fun get(id: UUID): Refund = toRefund(repository.findById(id).orElseThrow())

    fun markPaid(id: UUID) {
        locks.save(RefundLock(id.toString(), "payments", 30))
        val entity = repository.findById(id).orElseThrow()
        entity.status = "PAID"
        repository.save(entity)
    }

    /** No save: the loaded entity is changed inside a transaction and written on commit. */
    @Transactional
    fun cancel(id: UUID) {
        val entity = repository.findById(id).orElseThrow()
        entity.status = "CANCELLED"
    }

    @Transactional(readOnly = true)
    fun preview(id: UUID): String {
        val entity = repository.findById(id).orElseThrow()
        entity.status = "PREVIEW"
        return entity.status
    }

    private fun toRefund(e: RefundEntity) = Refund(e.id, e.amount, e.status)
}
