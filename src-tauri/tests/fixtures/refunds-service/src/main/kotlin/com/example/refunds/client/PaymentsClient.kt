package com.example.refunds.client

import org.springframework.cloud.openfeign.FeignClient
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import java.math.BigDecimal
import java.util.UUID

@FeignClient(name = "payments", url = "\${clients.payments.url}")
interface PaymentsClient {
    @PostMapping("/reservations")
    fun reserve(@RequestBody reservation: Reservation)
}

data class Reservation(val refundId: UUID, val amount: BigDecimal)
