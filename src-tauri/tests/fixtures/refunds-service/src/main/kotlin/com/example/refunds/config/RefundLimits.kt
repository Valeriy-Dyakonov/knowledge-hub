package com.example.refunds.config

import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties(prefix = "refunds.limits")
data class RefundLimits(
    val maxAmount: Long = 5000,
    val dailyCount: Int = 10,
)
