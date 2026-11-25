"""Join remaining Trivy findings with the report's component review."""
import csv
import json
from pathlib import Path

after = Path(__file__).resolve().parents[1] / "after"
checks = {
    "CVE-2026-47884": "В контроллерах приложения не используется XsltView. Проверка по исходникам.",
    "CVE-2026-47890": "В контроллерах приложения не найдена выдача SSE с фрагментами представлений. Проверка по исходникам.",
    "CVE-2026-47892": "В GatewayApplication маршруты задаются RouteLocatorBuilder. Функциональные WebFlux-обработчики с затронутой проверкой заголовков в коде не найдены.",
}
scope = {
    "osixia/openldap:1.5.0": "Внутренняя учебная замена университетского каталога. Проверка обновления требует переноса конфигурации LDAP и сверки работы bind и поиска.",
    "apache/kafka:3.9.2": "Внутренний брокер KRaft. Для смены ветки требуется проверить SASL, ACL, форматы и совместимость с клиентами.",
    "liquibase/liquibase:4.33.0": "Контейнер миграций получает changelog из проекта и завершается до штатной работы API. Смена образа требует отдельной проверки миграций на исходной БД.",
    "postgres:16.16-alpine": "База данных используется по внутренней сети. Изменение образа или пакетов требует проверки миграций и сохранности форматов данных.",
    "kafbat/kafka-ui:v1.5.1": "Служебный интерфейс доступен локально после входа. Достижимость в коде Kafka UI требует проверки upstream-реализации.",
}
details = {}
for path in (after / "trivy").glob("*.json"):
    raw = json.loads(path.read_text(encoding="utf-8"))
    for result in raw.get("Results", []):
        for item in result.get("Vulnerabilities") or []:
            key = raw["ArtifactName"], item["VulnerabilityID"], item["PkgName"], item["InstalledVersion"]
            details[key] = item, result["Target"]

with (after / "sca-high-critical.csv").open(encoding="utf-8-sig", newline="") as source:
    rows = list(csv.DictReader(source, delimiter=";"))

extra = ["цель Trivy", "заголовок бюллетеня", "источник", "оценка достижимости", "обоснование решения"]
with (after / "sca-residual-review.csv").open("w", encoding="utf-8-sig", newline="") as output:
    writer = csv.DictWriter(output, fieldnames=[*rows[0], *extra], delimiter=";")
    writer.writeheader()
    for row in rows:
        image = row["образ"]
        cve = row["CVE"]
        item, target = details[image, cve, row["пакет"], row["установлено"]]
        if image.startswith("scholarship-") and cve in checks:
            reach = checks[cve]
            decision = "Образ оставлен на Spring 6.2.19. Trivy указывает 7.0.9, переход требует обновления мажорной версии Spring Boot."
        else:
            reach = ("Прямой вызов из исходников приложения отсутствует. "
                     "Использование затронутой функции внутри этого образа не установлено.")
            fixed = ("Исправленная версия пакета указана Trivy. Наличие готового совместимого образа отдельно не подтверждено."
                     if item.get("FixedVersion") else "В исходном JSON Trivy исправленная версия пакета отсутствует.")
            decision = f"Остаточный риск; образ сохранён в учебном стенде. {scope[image]} {fixed}"
        row.update(zip(extra, [target, item.get("Title", ""), item.get("PrimaryURL", ""), reach, decision], strict=True))
        writer.writerow(row)
