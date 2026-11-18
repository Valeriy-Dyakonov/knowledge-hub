package com.example.refunds

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

@RestController
class FakeController {
    @GetMapping("/test-only")
    fun x() = "x"
}
