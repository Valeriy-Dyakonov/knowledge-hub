package com.example.refunds.api

import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("/internal")
class HealthController {
    @GetMapping("/ping")
    fun ping() = "pong"
}
