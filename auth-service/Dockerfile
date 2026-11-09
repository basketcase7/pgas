# Сборка из корня репозитория: docker build -f auth-service/Dockerfile .
FROM gradle:8.14.3-jdk21 AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/home/gradle/.gradle,sharing=locked \
    gradle :auth-service:bootJar --no-daemon -q

FROM eclipse-temurin:21-jre-alpine
# сервис работает не от root
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build /src/auth-service/build/libs/auth-service-*.jar app.jar
USER app
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
