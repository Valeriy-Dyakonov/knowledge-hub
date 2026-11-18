package com.example.refunds.persistence

import org.springframework.data.annotation.Id
import org.springframework.data.redis.core.RedisHash
import org.springframework.data.redis.core.TimeToLive
import org.springframework.data.repository.CrudRepository

/** Lock on a refund while it is being processed; lives in Redis. */
@RedisHash("refund-locks")
data class RefundLock(
    @Id val refundId: String,
    val owner: String,
    @TimeToLive val ttlSeconds: Long,
)

interface RefundLockRepository : CrudRepository<RefundLock, String>
