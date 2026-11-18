package com.example.refunds.events

import com.example.refunds.domain.RefundCreated
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.event.EventListener
import org.springframework.kafka.core.KafkaTemplate
import org.springframework.stereotype.Component

@Component
class RefundEventsListener(
    private val kafkaTemplate: KafkaTemplate<String, Any>,
    @Value("\${refunds.topics.created}") private val createdTopic: String,
) {
    @EventListener
    fun onCreated(event: RefundCreated) {
        kafkaTemplate.send(createdTopic, event.id.toString(), event)
    }
}
