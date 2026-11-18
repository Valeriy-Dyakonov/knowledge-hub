package com.example.refunds.service

import com.example.refunds.domain.Topics
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.kafka.core.KafkaTemplate
import org.springframework.stereotype.Service
import java.util.UUID

interface ApprovalService {
    fun approve(id: UUID)
}

@Service
class ManualApprovalService(private val jdbcTemplate: JdbcTemplate) : ApprovalService {
    override fun approve(id: UUID) {
        jdbcTemplate.update("update refunds set status = 'APPROVED' where id = ?", id)
    }
}

@Service
class AutoApprovalService(private val kafkaTemplate: KafkaTemplate<String, Any>) : ApprovalService {
    override fun approve(id: UUID) {
        kafkaTemplate.send(Topics.APPROVED, id.toString(), id)
    }
}
