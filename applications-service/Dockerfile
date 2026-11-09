# Сборка из корня репозитория: docker build -f applications-service/Dockerfile .
FROM gradle:8.14.3-jdk21 AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/home/gradle/.gradle,sharing=locked \
    gradle :applications-service:bootJar --no-daemon -q

FROM eclipse-temurin:21-jre-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build /src/applications-service/build/libs/applications-service-*.jar app.jar
USER app
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
