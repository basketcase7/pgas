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
