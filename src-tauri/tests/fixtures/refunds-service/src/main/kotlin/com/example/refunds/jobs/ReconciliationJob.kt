package com.example.refunds.jobs

import com.example.refunds.persistence.RefundRepository
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component
import org.springframework.web.client.RestTemplate

@Component
class ReconciliationJob(
    private val repository: RefundRepository,
    private val restTemplate: RestTemplate,
) {
    @Scheduled(cron = "0 0 * * * *")
    fun reconcile() {
        val pending = repository.findAllByStatus("PAID")
        restTemplate.getForObject("https://ledger.example.com/api/balance", String::class.java)
    }
}
