package ru.spbstu.scholarship.gateway

import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication
import org.springframework.cloud.gateway.route.RouteLocator
import org.springframework.cloud.gateway.route.builder.RouteLocatorBuilder
import org.springframework.context.annotation.Bean
import org.springframework.http.HttpMethod
import ru.spbstu.scholarship.platform.token.AccessTokenVerifier
import ru.spbstu.scholarship.platform.token.Pem

@SpringBootApplication
class GatewayApplication {

    @Bean
    fun accessTokenVerifier(@Value("\${gateway.jwt-public-key-b64}") key: String) =
        AccessTokenVerifier(Pem.publicKeyFromEnvValue(key))

    /**
     * Маршрутизация (B-04). Путь не переписывается: сервисы обслуживают тот же /api/v1/...
     * Наружу публикуется только префикс /api/v1; внутренние эндпоинты (/internal/...) и actuator
     * сервисов через шлюз недоступны — для них маршрута нет (404).
     * Маршруты review-service объявлены раньше общего маршрута applications-service.
     */
    @Bean
    fun routes(
        builder: RouteLocatorBuilder,
        @Value("\${gateway.routes.auth}") auth: String,
        @Value("\${gateway.routes.applications}") apps: String,
        @Value("\${gateway.routes.review}") review: String,
    ): RouteLocator = builder.routes()
        .route("auth") { r -> r.path("/api/v1/auth/**").uri(auth) }
        .route("review-patch") { r -> r.path("/api/v1/applications/*/review").and().method(HttpMethod.PATCH).uri(review) }
        .route("review-campaigns") { r -> r.path("/api/v1/campaigns/*/payout-registry", "/api/v1/campaigns/*/ranking").uri(review) }
        .route("applications") { r -> r.path("/api/v1/applications", "/api/v1/applications/**", "/api/v1/campaigns").uri(apps) }
        .build()
}

fun main(args: Array<String>) {
    runApplication<GatewayApplication>(*args)
}
