package com.example.refunds.notify

import com.example.refunds.persistence.RefundRepository
import org.springframework.scheduling.annotation.Async
import org.springframework.stereotype.Component

@Component
class CacheWarmer(private val repository: RefundRepository) {
    @Async
    fun warmUp() {
        repository.findAllByStatus("NEW")
    }
}
