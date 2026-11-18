package com.example.refunds.api

import com.example.refunds.domain.CreateRefund
import com.example.refunds.domain.Refund
import com.example.refunds.service.ApprovalService
import com.example.refunds.service.RefundService
import org.springframework.web.bind.annotation.*
import java.util.UUID

@RestController
@RequestMapping("/api/v1/refunds")
class RefundController(
    private val refundService: RefundService,
    private val approvalService: ApprovalService,
) {
    @PostMapping
    fun create(@RequestBody request: CreateRefund): Refund = refundService.create(request)

    @GetMapping("/{id}")
    fun get(@PathVariable id: UUID): Refund {
        return refundService.get(id)
    }

    @PostMapping("/{id}/cancel")
    fun cancel(@PathVariable id: UUID) {
        refundService.cancel(id)
    }

    @PostMapping("/{id}/approve")
    fun approve(@PathVariable id: UUID) {
        approvalService.approve(id)
    }
}
