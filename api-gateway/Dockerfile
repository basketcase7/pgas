# Сборка из корня репозитория: docker build -f api-gateway/Dockerfile .
FROM gradle:8.14.3-jdk21 AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/home/gradle/.gradle,sharing=locked \
    gradle :api-gateway:bootJar --no-daemon -q

FROM eclipse-temurin:21-jre-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build /src/api-gateway/build/libs/api-gateway-*.jar app.jar
USER app
EXPOSE 8443
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
