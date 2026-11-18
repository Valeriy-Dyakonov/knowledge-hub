package com.example.refunds.notify

import com.example.refunds.persistence.RefundRepository
import org.springframework.cache.annotation.Cacheable
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

    // After a property, an annotation string with `) >`; and a parameter called `dynamic`.
    @Cacheable(cacheNames = ["statuses"], condition = "#status.length() > 0")
    fun isWarm(status: String, dynamic: Boolean = false): Boolean = warmed[status] ?: dynamic
}
