#!/bin/sh
# docx -> pdf, текст для расчёта содержания, превью страниц
set -e
cd /work
soffice --headless --convert-to pdf --outdir /work /work/report.docx >/dev/null 2>&1
pdftotext -layout report.pdf report.txt
find /work -maxdepth 1 -name 'pg-*.jpg' -delete
pdftoppm -jpeg -r 50 report.pdf pg
