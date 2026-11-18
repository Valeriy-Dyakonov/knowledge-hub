package com.example.refunds.notify

import com.example.refunds.persistence.RefundRepository
import org.springframework.scheduling.annotation.Async
import org.springframework.stereotype.Component

@Component
class CacheWarmer(private val repository: RefundRepository) {
    private val warmed = mutableMapOf<String, Boolean>()

    // Raw string whose text ends with quotes: Kotlin closes it at the last three.
    private val emptyStatus = """"status": """""

    @Async
    fun warmUp() {
        repository.findAllByStatus("NEW")
        // Trailing comma inside brackets: valid Kotlin the grammar does not know.
        warmed[
            "NEW",
        ] = true
    }
}
