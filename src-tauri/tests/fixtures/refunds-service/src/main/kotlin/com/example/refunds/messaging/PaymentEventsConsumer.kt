package com.example.refunds.messaging

import com.example.refunds.service.RefundService
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.kafka.annotation.KafkaListener
import org.springframework.stereotype.Component
import java.util.UUID

@Component
class PaymentEventsConsumer(
    private val refundService: RefundService,
    private val jdbcTemplate: JdbcTemplate,
) {
    @KafkaListener(topics = ["\${payments.topics.completed}"], groupId = "refunds")
    fun onPaymentCompleted(message: String) {
        refundService.markPaid(UUID.fromString(message))
        audit("payment completed")
    }

    private fun audit(text: String) {
        val sql = "insert into " + table() + " (text) values (?)"
        jdbcTemplate.update(sql, text)
    }

    private fun table() = "audit_log"
}
