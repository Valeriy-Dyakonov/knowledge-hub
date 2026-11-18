package com.example.refunds.jobs

import com.example.refunds.config.RefundLimits
import com.example.refunds.persistence.RefundRepository
import org.springframework.core.env.Environment
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component
import org.springframework.web.client.RestTemplate

@Component
class ReconciliationJob(
    private val repository: RefundRepository,
    private val restTemplate: RestTemplate,
    private val limits: RefundLimits,
    private val env: Environment,
) {
    @Scheduled(cron = "\${refunds.reconciliation.cron:0 0 * * * *}")
    fun reconcile() {
        val pending = repository.findAllByStatus("PAID")
        val bySku = repository.findBySku("SKU-1")
        val region = env.getProperty("refunds.region")
        restTemplate.getForObject("https://ledger.example.com/api/balance", String::class.java)
    }
}
