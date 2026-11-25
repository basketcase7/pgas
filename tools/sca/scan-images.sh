#!/bin/sh
# SCA: Trivy по всем образам из docker-compose.yml + SBOM CycloneDX для каждого образа.
# Запуск из корня репозитория после `docker compose build`:  sh tools/sca/scan-images.sh docs/lab5/before
set -eu
OUT="${1:?каталог для отчётов}"
mkdir -p "$OUT/trivy" "$OUT/sbom"
IMAGES=$(docker compose config --images | sort -u)
TRIVY="docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v lab5-trivy-cache:/root/.cache -v $(pwd -W 2>/dev/null || pwd):/w -w /w aquasec/trivy:latest"
for img in $IMAGES; do
  name=$(echo "$img" | tr '/:' '__')
  echo ">>> $img"
  $TRIVY image --quiet --scanners vuln --format json --output "$OUT/trivy/$name.json" "$img"
  $TRIVY image --quiet --format cyclonedx --output "$OUT/sbom/$name.cdx.json" "$img"
done
echo "готово: $OUT"
