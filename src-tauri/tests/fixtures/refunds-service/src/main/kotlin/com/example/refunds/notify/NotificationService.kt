package com.example.refunds.notify

import org.springframework.scheduling.annotation.Async
import org.springframework.stereotype.Service
import org.springframework.web.client.RestTemplate
import java.util.UUID

@Service
class NotificationService(private val restTemplate: RestTemplate) {
    @Async
    fun notifyCustomer(refundId: UUID) {
        restTemplate.postForObject("https://notify.example.com/api/messages", refundId, String::class.java)
    }
}
