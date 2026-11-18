package com.example.refunds.persistence

import org.springframework.data.annotation.Id
import org.springframework.data.mongodb.core.mapping.Document
import org.springframework.data.mongodb.core.mapping.Field
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.mongodb.repository.MongoRepository

@Document(collection = "refund_snapshots")
data class RefundSnapshot(
    @Id val id: String,
    @Field("payload") val body: String,
)

interface RefundSnapshotRepository : MongoRepository<RefundSnapshot, String>

/** No mapping annotation: known only as the type of a JPA repository. */
data class RefundNote(val id: Long, val text: String)

interface RefundNoteRepository : JpaRepository<RefundNote, Long>
