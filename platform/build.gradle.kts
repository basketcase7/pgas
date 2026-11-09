// Общая библиотека сервисов. Spring-зависимости — compileOnly: каждый сервис
// подключает их сам, а шлюз (WebFlux) использует только пакет platform.token.
dependencies {
    api("com.nimbusds:nimbus-jose-jwt:10.3")
    api("com.fasterxml.jackson.module:jackson-module-kotlin")
    compileOnly("org.springframework.boot:spring-boot-starter-web")
    compileOnly("org.springframework.boot:spring-boot-starter-jdbc")
    compileOnly("org.springframework.boot:spring-boot-starter-data-redis")
    compileOnly("org.springframework.kafka:spring-kafka")
    implementation("org.jetbrains.kotlin:kotlin-reflect")
    implementation("org.slf4j:slf4j-api")
}
