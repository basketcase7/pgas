// Если локально нет JDK 21 (jvmToolchain(21)), Gradle скачает его сам —
// нужно для импорта проекта в IntelliJ IDEA; в Docker-сборке JDK 21 уже есть.
plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "0.10.0"
}

rootProject.name = "scholarship"

// platform — общая библиотека (проверка токена, ошибки, аудит, идемпотентность);
// это не контейнер, а код, который подключают сервисы.
include(
    "platform",
    "api-gateway",
    "auth-service",
    "applications-service",
    "review-service",
    "notifier",
)
