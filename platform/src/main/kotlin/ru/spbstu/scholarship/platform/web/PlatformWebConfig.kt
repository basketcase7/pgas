package ru.spbstu.scholarship.platform.web

import com.fasterxml.jackson.databind.ObjectMapper
import jakarta.servlet.http.HttpServletRequest
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.web.servlet.FilterRegistrationBean
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Import
import org.springframework.core.MethodParameter
import org.springframework.core.Ordered
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.web.bind.support.WebDataBinderFactory
import org.springframework.web.context.request.NativeWebRequest
import org.springframework.web.method.support.HandlerMethodArgumentResolver
import org.springframework.web.method.support.ModelAndViewContainer
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer
import ru.spbstu.scholarship.platform.security.AuthUser
import ru.spbstu.scholarship.platform.session.RedisSessionLookup
import ru.spbstu.scholarship.platform.session.SessionLookup
import ru.spbstu.scholarship.platform.token.AccessTokenVerifier
import ru.spbstu.scholarship.platform.token.Pem

/**
 * Общая веб-конфигурация сервисов: request_id, аутентификация по токену,
 * подстановка AuthUser в обработчики, единый обработчик ошибок.
 * Подключается в сервисе через @Import(PlatformWebConfig::class).
 */
@Configuration
@Import(ApiErrorHandler::class)
class PlatformWebConfig(
    @Value("\${security.jwt.public-key-b64}") private val publicKeyB64: String,
    @Value("\${security.public-paths:}") private val publicPaths: List<String>,
) : WebMvcConfigurer {

    @Bean
    fun accessTokenVerifier() = AccessTokenVerifier(Pem.publicKeyFromEnvValue(publicKeyB64))

    @Bean
    fun sessionLookup(redis: StringRedisTemplate): SessionLookup = RedisSessionLookup(redis)

    @Bean
    fun requestIdFilter() = FilterRegistrationBean(RequestIdFilter()).apply { order = Ordered.HIGHEST_PRECEDENCE }

    @Bean
    fun authenticationFilter(verifier: AccessTokenVerifier, sessions: SessionLookup, om: ObjectMapper) =
        FilterRegistrationBean(AuthenticationFilter(verifier, sessions, om, publicPaths.filter { it.isNotBlank() }))
            .apply { order = Ordered.HIGHEST_PRECEDENCE + 10 }

    override fun addArgumentResolvers(resolvers: MutableList<HandlerMethodArgumentResolver>) {
        resolvers.add(AuthUserArgumentResolver())
    }
}

/** Подставляет в параметр обработчика субъект из проверенного токена (никогда — из тела запроса). */
class AuthUserArgumentResolver : HandlerMethodArgumentResolver {
    override fun supportsParameter(parameter: MethodParameter) = parameter.parameterType == AuthUser::class.java

    override fun resolveArgument(
        parameter: MethodParameter, mav: ModelAndViewContainer?, req: NativeWebRequest, binder: WebDataBinderFactory?,
    ): AuthUser {
        val servletReq = req.getNativeRequest(HttpServletRequest::class.java)
        return servletReq?.getAttribute(AuthenticationFilter.AUTH_ATTR) as AuthUser? ?: throw Errors.unauthorized()
    }
}
