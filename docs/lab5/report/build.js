// Генерация отчёта по ЛР5 (DOCX → PDF через LibreOffice). Запуск:
//   NODE_PATH=<каталог с node_modules/docx> node docs/lab5/report/build.js <путь к lab3> <хеш «до»> <хеш «после»>
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell,
  WidthType, BorderStyle, ShadingType, LevelFormat, Footer, PageNumber, Tab, PageOrientation,
} = require('docx');
const collect = require('./data');

const ROOT = process.argv[2];
const H_BEFORE = process.argv[3];
const H_AFTER = process.argv[4];
const OUT = path.join(ROOT, 'docs', 'lab5', 'report');
const D = collect(ROOT);
const B = D.before, A = D.after;
const finalEvidence = path.join(ROOT, 'docs', 'lab5', 'after');
const verifiedSpotBugs = fs.existsSync(path.join(finalEvidence, 'spotbugs-verified', 'summary.json'))
  ? JSON.parse(fs.readFileSync(path.join(finalEvidence, 'spotbugs-verified', 'summary.json'), 'utf8'))
  : null;

const FONT = 'Times New Roman';
const CODE = 'Consolas';
const PAGE_W = 11906 - 1701 - 850;

// ------------------------------------------------------------------ helpers (как в отчёте ЛР3)
const t = (text, o = {}) => new TextRun({ text, font: FONT, size: 28, ...o });
function P(content, o = {}) {
  const runs = (Array.isArray(content) ? content : [content]).map(c => typeof c === 'string' ? t(c) : c);
  return new Paragraph({ children: runs, alignment: o.align ?? AlignmentType.JUSTIFIED,
    indent: o.noIndent ? undefined : { firstLine: 709 }, spacing: { line: 360, before: 0, after: o.after ?? 0 }, keepNext: o.keepNext });
}
function rich(s, size = 28) {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map(p => p.startsWith('**') ? t(p.slice(2, -2), { bold: true, size })
    : p.startsWith('`') ? new TextRun({ text: p.slice(1, -1), font: CODE, size: size - 4 }) : t(p, { size }));
}
const p = (s, o) => P(rich(s), o);
const HEADS = [];
const H1 = (s) => (HEADS.push([1, s]), new Paragraph({ heading: HeadingLevel.HEADING_1, children: [t(s, { bold: true, size: 32 })], pageBreakBefore: /^1\./.test(s) }));
const H2 = (s) => (HEADS.push([2, s]), new Paragraph({ heading: HeadingLevel.HEADING_2, children: [t(s, { bold: true, size: 28 })] }));
const bullet = (s) => new Paragraph({ children: rich(s), numbering: { reference: 'bul', level: 0 }, alignment: AlignmentType.JUSTIFIED, spacing: { line: 360 } });
const tcap = (s) => new Paragraph({ children: [t(s, { size: 26 })], alignment: AlignmentType.LEFT, spacing: { before: 200, after: 60 }, keepNext: true });
let TN = 0;
const T = (s) => tcap(`Таблица ${++TN} – ${s}`);
function code(lines) {
  return lines.split('\n').map((l, i, a) => new Paragraph({
    children: [new TextRun({ text: l.length ? l : ' ', font: CODE, size: 18 })],
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F2F2F2' },
    spacing: { line: 240, before: i === 0 ? 80 : 0, after: i === a.length - 1 ? 160 : 0 },
    indent: { left: 113, right: 113 },
  }));
}
const border = { style: BorderStyle.SINGLE, size: 4, color: '000000' };
const borders = { top: border, bottom: border, left: border, right: border };
function table(header, rows, weights, sz = 20) {
  const total = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map(w => Math.floor(PAGE_W * w / total));
  widths[widths.length - 1] += PAGE_W - widths.reduce((a, b) => a + b, 0);
  const cell = (txt, i, head) => new TableCell({
    borders, width: { size: widths[i], type: WidthType.DXA },
    shading: head ? { type: ShadingType.CLEAR, color: 'auto', fill: 'E7E6E6' } : undefined,
    margins: { top: 30, bottom: 30, left: 70, right: 70 },
    children: String(txt).split('\n').map(line => new Paragraph({
      children: line.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean).map(seg => seg.startsWith('`')
        ? new TextRun({ text: seg.slice(1, -1), font: CODE, size: sz - 3 })
        : seg.startsWith('**') ? new TextRun({ text: seg.slice(2, -2), font: FONT, size: sz, bold: true })
          : new TextRun({ text: seg, font: FONT, size: sz, bold: head })),
      spacing: { line: 228 },
    })),
  });
  return new Table({
    width: { size: PAGE_W, type: WidthType.DXA }, columnWidths: widths,
    rows: [new TableRow({ tableHeader: true, cantSplit: true, children: header.map((h, i) => cell(h, i, true)) }),
      ...rows.map(r => new TableRow({ cantSplit: true, children: r.map((c, i) => cell(c, i, false)) }))],
  });
}
const blank = () => new Paragraph({ children: [t('')] });
const center = (s, o = {}) => new Paragraph({ alignment: AlignmentType.CENTER, children: [t(s, o)], spacing: { line: 300 } });
const short = (h) => h.slice(0, 7);
const sumHC = (imgs, f = () => true) => imgs.filter(f).reduce((a, c) => a + c.CRITICAL + c.HIGH, 0);
const sumSev = (imgs, s, f = () => true) => imgs.filter(f).reduce((a, c) => a + c[s], 0);
const ours = (c) => c.image.startsWith('scholarship-');
const fmtZ = (z) => z ? `${z.High}/${z.Medium}/${z.Low}/${z.Informational}` : '—';

// ------------------------------------------------------------------ документ
const children = [];
const add = (...x) => children.push(...x.flat());

// ===== Титульный лист
add(
  center('Министерство науки и высшего образования Российской Федерации'),
  center('Санкт-Петербургский политехнический университет Петра Великого'),
  center('Институт компьютерных наук и кибербезопасности'),
  blank(), blank(), blank(), blank(),
  center('ОТЧЁТ ПО ЛАБОРАТОРНОЙ РАБОТЕ №5', { bold: true }),
  center('«Проверка защищённости реализации: SAST, DAST, SCA»', { bold: true }),
  center('по курсу «Основы разработки безопасных цифровых систем»'),
  blank(),
  center(`Коммит «до»: ${H_BEFORE}`, { size: 24 }),
  center(`Коммит «после»: ${H_AFTER}`, { size: 24 }),
  center('репозиторий lab3, ветка lab5', { size: 24 }),
  blank(), blank(),
  new Paragraph({ alignment: AlignmentType.RIGHT, children: [t('Работу выполнил студент группы №5140901/61501')] }),
  new Paragraph({ alignment: AlignmentType.RIGHT, children: [t('_______________ Чикилев М.А.')] }),
  blank(),
  new Paragraph({ alignment: AlignmentType.RIGHT, children: [t('Работу принял преподаватель')] }),
  new Paragraph({ alignment: AlignmentType.RIGHT, children: [t('_______________ Арушанян А.В.')] }),
  blank(),
  new Paragraph({ alignment: AlignmentType.RIGHT, children: [t('“25” ноября 2026 года')] }),
  blank(), blank(), blank(),
  center('Санкт-Петербург'), center('2026'),
);

// ===== Содержание (номера страниц — второй проход)
add(new Paragraph({ children: [t('Содержание', { bold: true, size: 32 })], alignment: AlignmentType.CENTER, pageBreakBefore: true, spacing: { after: 240 } }));
const TOC_AT = children.length;

// ===== 1. Объект проверки
const fixes = [
  ['fe46f68', 'V-M01', 'OP-01: служба поддержки (R-07) получает только статус заявки'],
  ['46f89ab', 'V-M02', 'Черновики заявителей вне области видимости сотрудников (OP-01, OP-03, OP-04)'],
  ['d4a3323', 'V-M03, V-S04', 'OP-06/OP-11: проверка прав на заявку до ответа 501, раздельные GET и POST'],
  ['6602f07', 'V-M04', 'OP-16: лимит 5/15 мин на шлюзе и отзыв сессии после 5 неудач повторного ввода пароля'],
  ['35d7bd0', 'V-D01', 'Шлюз: CSP, Cross-Origin-Resource-Policy, Referrer-Policy для ответов API'],
  ['cc827bb, 98d2d93', 'V-S01, V-D02', 'nginx: заголовки только на уровне server (map вместо add_header в location), Permissions-Policy, COOP/COEP/CORP'],
  ['8467994, 2e3fea6', 'V-C01', 'Веб-контейнеры: nginx 1.30.8 без root, обновление пакетов ОС при сборке'],
  ['4396a54', 'V-C02, V-S03', 'object-storage: SeaweedFS 4.55, запуск от пользователя seaweed'],
  ['28fb95e, 4410ddd, 6fbc639', 'V-C03', 'Зависимости: Spring Boot 3.5.16, Spring Cloud 2025.0.3, Jackson 2.21.9, Tomcat 10.1.62, Netty 4.1.141, pgjdbc 42.7.15, minio 8.6.0, bcprov 1.87, snappy, lz4, guava'],
  ['b31435c', 'V-C04', 'Образы инфраструктуры: Kafka 3.9.2, PostgreSQL 16.16, Redis 7.4.12, Liquibase 4.33.0'],
  ['aa20549', 'V-D03', 'Kafka UI: обязательный вход, kafbat/kafka-ui v1.5.1'],
  ['7e583ab', 'V-D04', 'Mailpit: вход в интерфейс и API, v1.34'],
  ['a5af2e4', 'V-D05', 'Строки JSON с U+0000 отклоняются при разборе (400 вместо 500)'],
  ['d02e7a5', 'V-S02', 'Коллекция запросов: пароли регистрации и восстановления генерируются при прогоне'],
  ['9a5bb3a', '—', 'Конфигурация gitleaks с разобранными исключениями (для запуска в CI)'],
];
add(
  H1('1. Объект проверки и порядок работы'),
  p(`Объект — система из ЛР № 3 (репозиторий lab3, 15 контейнеров docker compose: api-gateway, auth-service, applications-service, review-service, notifier, два nginx-клиента, PostgreSQL, Kafka, Redis, SeaweedFS, заглушки LDAP и Mailpit, Kafka UI, служебные liquibase и kafka-init). Работа велась в ветке \`lab5\`. **Коммит «до» — \`${H_BEFORE}\`** (последний коммит ЛР № 3), **коммит «после» — \`${H_AFTER}\`**. Каждое исправление — отдельный коммит (таблица 1), исходные отчёты инструментов «до» добавлены коммитами 382b7bd и 883a067 без изменений кода.`),
  p('Сканировалась только собственная система: сервисы опубликованы на 127.0.0.1, ZAP запускался в контейнере в сети `scholarship_frontend` того же docker compose. Порядок: SAST и SCA по коду и образам коммита «до» → запуск системы из этого коммита на чистой БД → ручные проверки и три прогона ZAP → исправления отдельными коммитами → полная пересборка (`docker compose down -v`, `build --pull`) → регрессионный прогон коллекции ЛР № 3 → повтор всех трёх видов анализа.'),
  p(`Регрессия после исправлений: коллекция \`requests/run-all.mjs\` из ЛР № 3 — **успешно ${A.runAll ? A.runAll[0] : '—'}, ошибок ${A.runAll ? A.runAll[1] : '—'}** (в ЛР № 3 — 149 из 149), то есть обновления зависимостей и образов и новые ограничения доступа не сломали функциональность.`),
  T('Коммиты исправлений'),
  table(['Коммит', 'Находки', 'Что сделано'], fixes, [18, 14, 68]),
);

// ===== 2. Инструменты
add(
  H1('2. Инструменты'),
  T('Инструменты анализа'),
  table(['Вид анализа', 'Инструмент и версия', 'Почему выбран'], [
    ['SAST', 'Semgrep 1.186.0, наборы p/kotlin, p/java, p/javascript, p/dockerfile, p/docker-compose, p/nginx, p/secrets, p/security-audit, p/owasp-top-ten, p/jwt', 'Один инструмент на все языки репозитория (Kotlin, JS клиентов, Dockerfile, nginx, compose); SARIF; не требует сервера и сборки'],
    ['SAST', 'SpotBugs 4.9.6 + FindSecBugs 1.14.0 (init-скрипт Gradle `tools/sast/spotbugs.init.gradle`, проект не меняется)', 'У Semgrep мало правил для Kotlin; FindSecBugs анализирует байткод JVM — одинаково для Kotlin и Java — и знает Spring (эндпоинты, CSRF, LDAP, CRLF в журналах)'],
    ['SAST (конфигурация)', 'Trivy 0.76.2, режим config', 'Проверки Dockerfile (запуск от root, HEALTHCHECK); тот же инструмент, что для SCA'],
    ['Секреты', 'gitleaks 8.30.1, режимы git (`--log-opts=--all`) и dir', 'Вся история всех ссылок, включая refs/original, оставшиеся после переписывания истории в ЛР № 3; dir — для итогового дерева'],
    ['SCA', 'Trivy 0.76.2, режим image, все 15 образов docker-compose.yml', 'Находит библиотеки внутри fat-jar Spring Boot, пакеты ОС и Go-бинарники; один отчёт на образ. OWASP Dependency-Check видел бы только Java-зависимости, а Gradle-проект без lock-файла не сканируется в режиме fs'],
    ['SBOM', 'Trivy → CycloneDX 1.7 (JSON), по файлу на образ', 'Тот же инструмент и та же база, что для SCA; CycloneDX читают Dependency-Track и Trivy'],
    ['Зависимости', 'gradle dependencies --configuration runtimeClasspath', 'Определение прямых и транзитивных зависимостей (через что пришла уязвимая)'],
    ['DAST', 'OWASP ZAP 2.17.0: zap-api-scan (импорт OpenAPI, пассивное + активное), zap-full-scan (spider + пассивное + активное)', 'Основной инструмент по заданию; для API составлена спецификация `docs/openapi.yaml` (в ЛР № 3 её не было); токен — хуком `tools/dast/zap_auth_hook.py`'],
    ['DAST (ручной)', '`requests/lab5-manual-checks.mjs` (Node.js 24, сырые HTTP-запросы)', 'Проверки, которых сканер не делает: права на объект, подделанные токены, повтор неидемпотентных операций, обход пути «..»'],
  ], [14, 38, 48]),
);

// ===== 3. SAST
const sb = (ph) => D[ph].spotbugs;
add(
  H1('3. SAST — статический анализ кода'),
  H2('3.1. Сводка по уровням'),
  p('Уровни приведены так, как их выдаёт инструмент: у Semgrep ERROR/WARNING соответствуют High/Medium, у SpotBugs приоритет 1/2/3 — High/Medium/Low. SpotBugs запускался по всем шести модулям (5 сервисов и общая библиотека platform), Semgrep — по всему репозиторию, кроме каталогов сборки.'),
  T('SAST «до» — находки по уровням'),
  table(['Инструмент', 'High / ERROR', 'Medium / WARNING', 'Low', 'Всего'], [
    ['Semgrep', B.semgrep.ERROR, B.semgrep.WARNING, '—', B.semgrep.total],
    ['SpotBugs + FindSecBugs', sb('before').byPrio[1], sb('before').byPrio[2], sb('before').byPrio[3], sb('before').total],
    ['Trivy config', B.trivyConfig.HIGH, B.trivyConfig.MEDIUM, B.trivyConfig.LOW, B.trivyConfig.HIGH + B.trivyConfig.MEDIUM + B.trivyConfig.LOW],
    ['gitleaks (вся история)', '—', '—', '—', `${B.gitleaks} (3 уникальных места)`],
  ], [34, 16, 18, 14, 18]),
  p(`Категории SpotBugs «до»: ${Object.entries(sb('before').byCat).map(([k, v]) => `${k} — ${v}`).join(', ')}. Из ${sb('before').total} находок ${sb('before').byRule.EI_EXPOSE_REP + sb('before').byRule.EI_EXPOSE_REP2 + sb('before').byRule.MS_EXPOSE_REP} — EI_EXPOSE_REP/REP2/MS_EXPOSE_REP (Kotlin data-классы и внедрение зависимостей через конструктор) и ${sb('before').byRule.SPRING_ENDPOINT} — SPRING_ENDPOINT (информационный перечень эндпоинтов, использован для сверки с картой кода).`),
  H2('3.2. Разбор находок'),
  p('Ниже разобраны все находки уровня High и все Medium и Low, относящиеся к безопасности; однотипные находки одного правила сгруппированы. Строки — по коду коммита «до».'),
  T('Разбор находок SAST'),
  table(['ID', 'Инструмент, место и суть', 'Уровень', 'Вердикт и обоснование', 'Исправление'], [
    ['V-S03', 'Semgrep `dockerfile.security.missing-user-entrypoint`, `object-storage/Dockerfile:5`; Trivy DS-0002 там же: хранилище вложений работает от root', 'High (ERROR / HIGH)', '**Подтверждена.** В образе SeaweedFS 3.97 нет USER, процесс `weed` с правами root обрабатывает S3-запросы, приходящие из браузера через nginx', '4396a54: SeaweedFS 4.55, USER seaweed (uid 1000)'],
    ['V-S05', 'Trivy DS-0002, `applicant-web/Dockerfile`, `staff-panel/Dockerfile`: nginx от root', 'High', '**Подтверждена.** Мастер-процесс nginx в образе nginx:1.27-alpine запущен от root; при уязвимости в nginx (а их в 1.27 Critical, см. раздел 4) атакующий получает root в контейнере', '8467994, 2e3fea6: nginx 1.30.8, uid 101'],
    ['V-S04', 'FindSecBugs `SPRING_CSRF_UNRESTRICTED_REQUEST_MAPPING`, `ApplicationsController.kt:109` — `@RequestMapping(method=[POST, GET])` для completeness-check', 'High (приоритет 1)', '**Ложное по сути (CSRF):** API аутентифицируется заголовком Authorization, который браузер не подставляет в межсайтовый запрос; cookie есть только у /auth/refresh (SameSite=Strict + обязательный X-Requested-With). Но совмещённый GET/POST — плохая практика, а при ручном разборе в этом же обработчике найдена V-M03', 'd4a3323: раздельные @PostMapping/@GetMapping'],
    ['V-S01', 'Semgrep `generic.nginx.security.header-redefinition`, `applicant-web/nginx.conf:37,39,40`, `staff-panel/nginx.conf:37,39,40`', 'Medium (WARNING)', '**Подтверждена** (ручная проверка D8): add_header в location /applications-attachments/ отменял заголовки server-блока — документ с ПДн отдавался без Referrer-Policy и X-Frame-Options и кэшировался. Первая правка (повтор заголовков) правило не закрыла и была хрупкой', 'cc827bb, затем 98d2d93: в location нет add_header, отличия — через map'],
    ['V-S06', 'Semgrep `generic.nginx.security.request-host-used`, `nginx.conf:22` (оба клиента): `proxy_set_header Host $host`', 'Medium (WARNING)', '**Ложное.** Host передаётся только шлюзу; шлюз маршрутизирует по пути на фиксированные адреса сервисов, ссылок и редиректов из Host не строит, Location в OP-02 относительный; у nginx один server с `server_name _`', 'Не требуется'],
    ['V-S07', 'FindSecBugs `LDAP_INJECTION`, `platform/.../LdapCatalog.kt:49`', 'Medium', '**Ложное.** Фильтр `(uid={0})` с массивом filterArgs: JNDI экранирует значение по RFC 4515; при регистрации логин дополнительно проверяется регулярным выражением `^[A-Za-z0-9._-]{3,64}$`; ручная проверка F4 (`*)(uid=*`) → 400', 'Не требуется'],
    ['V-S08', 'FindSecBugs `CRLF_INJECTION_LOGS` — 14 мест: `ApiErrorHandler.kt:76`, `GatewayFilters.kt:117,166`, `Filters.kt:76`, `Events.kt:59,60`, `ApplicationService.kt:100`, `ObjectStorage.kt:67`, `NotificationListener.kt:63,87,90,104,110`, `NotifierApplication.kt:29`', 'Low (приоритет 3)', '**Ложное.** В журнал попадают: requestURI (сырой CR/LF в строке запроса Tomcat отклоняет, закодированный остаётся %0D%0A), коды причин из InvalidTokenException (константы), UUID из проверенного токена или из БД, ключ объекта, сгенерированный сервером, поля событий Kafka (писать в топики могут только свои сервисы — ACL)', 'Не требуется'],
    ['V-S09', 'FindSecBugs `SERVLET_HEADER`, `Filters.kt:35,69` — чтение X-Request-Id и Authorization', 'Low', '**Ложное.** X-Request-Id принимается только как корректный UUID, Authorization — только после проверки подписи RS256, срока, iss/aud и сессии', 'Не требуется'],
    ['V-S10', 'FindSecBugs `COOKIE_USAGE`, `AuthController.kt:56` — токен обновления в cookie', 'Low', '**Ложное (решение по проекту D-20).** Cookie HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth, значение — 256 случайных бит, в Redis — только SHA-256, ротация с обнаружением повторного использования (проверка D5)', 'Не требуется'],
    ['V-S11', 'SpotBugs `NP_NULL_PARAM_DEREF`, `GatewayFilters.kt:162`; `NP_NULL_ON_SOME_PATH_FROM_RETURN_VALUE`, `SessionStore.kt:59,68`, `NotificationListener.kt:86`', 'Medium/Low', '**Ложное.** Заголовок X-Request-Id установлен двумя строками выше; операции StringRedisTemplate возвращают null только в конвейере/транзакции, которые не используются; Kotlin-платформенные типы', 'Не требуется'],
    ['V-S12', 'SpotBugs `CT_CONSTRUCTOR_THROW`, `PasswordHasher.kt:22`', 'Medium', '**Ложное.** Атака через finalizer требует чужого кода в JVM; бин создаёт Spring, исключение при коротком перце — намеренная остановка запуска', 'Не требуется'],
    ['V-S13', `SpotBugs EI_EXPOSE_REP/REP2/MS_EXPOSE_REP (${sb('before').byRule.EI_EXPOSE_REP + sb('before').byRule.EI_EXPOSE_REP2 + sb('before').byRule.MS_EXPOSE_REP}), BC_BAD_CAST_TO_ABSTRACT_COLLECTION (12), SA_LOCAL_SELF_ASSIGNMENT (2), RCN_REDUNDANT_NULLCHECK (2), DLS_DEAD_LOCAL_STORE (1)`, 'Medium/Low', '**Ложные.** Data-классы и конструкторное внедрение Kotlin; приведения, присваивания и проверки null, сгенерированные компилятором Kotlin (inline-функции коллекций, `?:`); в исходном коде их нет', 'Не требуется'],
    ['V-S14', 'Trivy DS-0026 «No HEALTHCHECK» — 8 Dockerfile', 'Low', '**Ложное для 6 сервисов** — healthcheck задан в docker-compose.yml (`/actuator/health`, `test -f /tmp/bucket-ready`). Для двух nginx-клиентов healthcheck действительно нет — это доступность, а не защищённость; оставлено', 'Не требуется'],
    ['V-S02', 'gitleaks `generic-api-key`, `requests/run-all.mjs:340,342` в коммитах f47d346 и 97de77e', 'Low', '**Подтверждена:** пароли тестовой регистрации stud010 и смены пароля stud003 записаны литералами и после прогона становились действующими паролями учётных записей стенда. Это не боевые секреты: стенд локальный, сбрасывается `down -v`', 'd02e7a5: пароли генерируются при каждом прогоне'],
    ['V-S15', 'gitleaks `generic-api-key`, `.env.example:58` (коммиты c3f8214, 299bca6)', '—', '**Ложное.** Значение пустое; регулярное выражение захватило имя следующей переменной `S3_APPLICATIONS_SECRET_KEY` как значение. `.env` и `secrets/` в истории не встречаются ни разу (`git log --all -- .env secrets`)', '9a5bb3a: исключение в .gitleaks.toml'],
  ], [7, 30, 10, 37, 16], 18),
  H2('3.3. Ручной обход карты кода: роль и владелец в каждом обработчике'),
  p('SAST проверяет поток данных внутри функции, но не знает, кому принадлежит объект и что разрешено роли, поэтому нарушения контроля доступа на уровне объекта он не видит. По карте кода ЛР № 3 (`docs/code-map.md`) пройдены все обработчики: где проверяется право роли на операцию и где — права на конкретный объект.'),
  T('Проверки роли и владельца в обработчиках (состояние «до»)'),
  table(['Операция', 'Обработчик', 'Право роли', 'Права на объект', 'Итог'], [
    ['OP-01 GET /applications/{id}', 'ApplicationsController.get → findVisible', 'applications:read', 'В SQL: владелец или подразделение кампании', '**V-M01**: R-07 получает текст и основания; **V-M02**: сотрудники видят черновики'],
    ['OP-02 POST /applications', 'create', 'applications:create', 'Владелец из токена, статус — DEFAULT; каталог LDAP', 'Нарушений нет'],
    ['OP-03 PATCH …/review', 'ReviewService.review → lockForReview', 'applications:review', 'Подразделение в SQL + конфликт интересов', '**V-M02**: черновик → 400 вместо 404'],
    ['OP-04 GET /applications', 'list', 'applications:list', 'Область в WHERE задаёт сервер', '**V-M02**: черновики в списке сотрудника'],
    ['OP-05 POST …/payout-registry', 'createRegistry', 'payout:create + повторный пароль', 'Кампания своей комиссии; заявки этой кампании, approved', 'Нарушений нет'],
    ['OP-06/OP-11 …/completeness-check', 'completeness', 'completeness:request', '**Нет**', '**V-M03**: 501 на любой id'],
    ['OP-10 …/attachments', 'requestUpload → lockOwn', 'attachments:create', 'Только своя заявка (FOR UPDATE)', 'Нарушений нет'],
    ['OP-12 …/ranking', 'ranking → campaignInUnit', 'ranking:read', 'Кампания своего подразделения', 'Нарушений нет'],
    ['OP-13 DELETE, OP-18 submit', 'withdraw / submit → lockOwn', 'withdraw / submit', 'Только своя заявка', 'Нарушений нет'],
    ['OP-17 GET /campaigns', 'campaigns', 'campaigns:read', 'Открытые или своего подразделения', 'Нарушений нет'],
    ['OP-07/08/09/14/15', 'AuthController', 'Публичные / токен', 'Субъект только из токена или cookie', 'Нарушений нет'],
    ['OP-16 POST /auth/reauth', 'reauth', 'Токен', 'Своя сессия', '**V-M04**: нет лимита перебора пароля'],
    ['/internal/users/{id}/contact', 'InternalController', 'Сервисный токен (constantTimeEquals)', 'Нет маршрута через шлюз', 'Нарушений нет (проверка G1)'],
  ], [19, 22, 15, 24, 20], 18),
  T('Находки ручного разбора кода'),
  table(['ID', 'Место и суть', 'Уровень', 'Вердикт и обоснование', 'Исправление'], [
    ['V-M01', '`ApplicationService.get`: служба поддержки (R-07) по OP-01 получала `statement`, `declared_grounds` (инвалидность, малоимущность) и `applicant_id`', 'High', '**Подтверждена** (I1). По реестру ролей ЛР № 1 R-07 — «просмотр статуса заявки по обращению, без доступа к вложениям». Ограничены были только вложения, сведения особой категории (о здоровье) отдавались целиком — нарушение на уровне свойств объекта (OWASP API3:2023)', 'fe46f68'],
    ['V-M02', '`findVisible`, `list`, `lockForReview`: условие «кампания своего подразделения» без учёта статуса', 'Medium', '**Подтверждена** (I2–I4). Сотрудник читал неподанный черновик e03 (200), видел черновики в списке, а OP-03 отвечал 400 «draft → under_review», подтверждая существование черновика', '46f89ab'],
    ['V-M03', '`ApplicationsController.completeness`: проверяется только право роли', 'Low', '**Подтверждена** (I5). Заглушка отвечала 501 и на чужую заявку — проверки владельца в обработчике нет; при реализации OP-06 это стало бы IDOR', 'd4a3323'],
    ['V-M04', '`AuthService.reauth` + правила шлюза: OP-16 проверяет пароль по токену доступа, но попадал под общее правило 300/мин', 'Medium', '**Подтверждена** (H2: 30 неверных паролей подряд без 429). Украденным токеном доступа можно перебирать пароль владельца', '6602f07'],
    ['V-M05', '`docker-compose.yml`: `KAFKA_SUPER_USERS: User:admin;User:ANONYMOUS`', 'Low', '**Принята.** ANONYMOUS — принципал PLAINTEXT-листенеров BROKER и CONTROLLER, которым в режиме KRaft нужны права суперпользователя. Оба листенера привязаны к localhost внутри контейнера брокера; другим контейнерам доступен только SASL-листенер с ACL', 'Оставлено с обоснованием'],
  ], [7, 30, 9, 40, 14], 18),
);

// ===== 4. SCA
const imgRow = (name) => {
  const b = B.images.find(c => c.image === name.b), a = A.images.find(c => c.image === name.a);
  return [name.label, name.b, b ? `${b.CRITICAL} / ${b.HIGH}` : '—', name.a, a ? `${a.CRITICAL} / ${a.HIGH}` : '—', name.decision];
};
const imgs = [
  { label: 'api-gateway', b: 'scholarship-api-gateway', a: 'scholarship-api-gateway', decision: 'V-C03; остаток — Spring Framework 6.2.19 (недостижимо)' },
  { label: 'auth-service', b: 'scholarship-auth-service', a: 'scholarship-auth-service', decision: 'V-C03' },
  { label: 'applications-service', b: 'scholarship-applications-service', a: 'scholarship-applications-service', decision: 'V-C03' },
  { label: 'review-service', b: 'scholarship-review-service', a: 'scholarship-review-service', decision: 'V-C03' },
  { label: 'notifier', b: 'scholarship-notifier', a: 'scholarship-notifier', decision: 'V-C03' },
  { label: 'applicant-web', b: 'scholarship-applicant-web', a: 'scholarship-applicant-web', decision: 'V-C01' },
  { label: 'staff-panel', b: 'scholarship-staff-panel', a: 'scholarship-staff-panel', decision: 'V-C01' },
  { label: 'object-storage', b: 'scholarship-object-storage', a: 'scholarship-object-storage', decision: 'V-C02' },
  { label: 'kafka, kafka-init', b: 'apache/kafka:3.9.1', a: 'apache/kafka:3.9.2', decision: 'V-C04; остаток обоснован (4.4)' },
  { label: 'kafka-ui', b: 'provectuslabs/kafka-ui:v0.7.2', a: 'kafbat/kafka-ui:v1.5.1', decision: 'V-D03; остаток обоснован' },
  { label: 'postgres', b: 'postgres:16-alpine', a: 'postgres:16.16-alpine', decision: 'V-C04; остаток обоснован' },
  { label: 'liquibase', b: 'liquibase/liquibase:4.31.1', a: 'liquibase/liquibase:4.33.0', decision: 'V-C04; остаток обоснован' },
  { label: 'redis', b: 'redis:7.4-alpine', a: 'redis:7.4.12-alpine', decision: 'V-C04' },
  { label: 'mailpit', b: 'axllent/mailpit:v1.27', a: 'axllent/mailpit:v1.34', decision: 'V-D04' },
  { label: 'ldap', b: 'osixia/openldap:1.5.0', a: 'osixia/openldap:1.5.0', decision: 'Оставлен с обоснованием (4.4)' },
];
add(
  H1('4. SCA — анализ сторонних компонентов'),
  H2('4.1. Сводка по образам'),
  p(`Trivy проверил все 15 образов из docker-compose.yml (два контейнера Kafka используют один образ, поэтому отчётов 15 с учётом всех клиентов и служебных контейнеров). Для образов сервисов проверяются и библиотеки внутри fat-jar Spring Boot (BOOT-INF/lib), и пакеты ОС базового образа eclipse-temurin:21-jre-alpine. Всего High и Critical «до»: **${sumHC(B.images)}**, из них в собственных образах — **${sumHC(B.images, ours)}** (библиотеки — ${B.images.filter(ours).reduce((a, c) => a + c.libHC, 0)}, пакеты ОС — ${B.images.filter(ours).reduce((a, c) => a + c.osHC, 0)}); «после» — **${sumHC(A.images)}** и **${sumHC(A.images, ours)}** соответственно.`),
  T('Critical / High по образам до и после'),
  table(['Контейнер', 'Образ «до»', 'C / H', 'Образ «после»', 'C / H', 'Решение'], imgs.map(imgRow), [15, 22, 8, 22, 8, 25], 18),
  p('Полный перечень каждой уязвимости High и Critical с полями задания (CVE, CVSS, пакет, текущая и исправленная версия, прямая или транзитивная — с указанием, через какую объявленную зависимость пришла, — и используется ли уязвимая функция) сформирован автоматически по отчётам Trivy и деревьям Gradle: `docs/lab5/before/sca-high-critical.csv` и `docs/lab5/after/sca-high-critical.csv` (скрипт `tools/sca/hc-table.mjs`). Ниже — разбор по пакетам.'),
  H2('4.2. SBOM'),
  p(`SBOM сформирован Trivy в формате **CycloneDX ${B.sbom[0].spec}** (JSON), отдельный файл на образ: \`docs/lab5/before/sbom/*.cdx.json\` (${B.sbom.length} файлов, ${B.sbom.reduce((a, s) => a + s.components, 0)} компонентов) и \`docs/lab5/after/sbom/*.cdx.json\` (${A.sbom.length} файлов, ${A.sbom.reduce((a, s) => a + s.components, 0)} компонентов). Для образа сервиса, например auth-service, SBOM содержит ${(B.sbom.find(s => s.file.includes('auth-service')) || {}).components} компонентов: пакеты Alpine, JRE и все jar из BOOT-INF/lib с purl \`pkg:maven/...\`. SBOM нужен, чтобы при появлении новой CVE ответить «где у нас этот компонент», не пересобирая и не сканируя всё заново.`),
  H2('4.3. Уязвимости High и Critical в библиотеках сервисов'),
  T('Разбор High/Critical зависимостей приложения (по пакетам)'),
  table(['Пакет', 'CVE (High/Critical)', 'Версия → исправленная', 'Прямая / транзитивная', 'Используется ли уязвимая функция', 'Решение'], [
    ['tomcat-embed-core', 'CVE-2026-41293, -43512 (C); -24734, -24880, -34483, -34487, -41284, -42498; после Boot 3.5.16 — -55276, -65182, -65637, -65905, -68525 (C), -53404', '10.1.46 → 10.1.55 → **10.1.62**', 'Транзитивная (spring-boot-starter-web)', 'Частично: разбор HTTP/1.1 (CVE-2026-24880, chunk extension) достижим; HTTP/2, DIGEST/FORM-аутентификация, security-constraint, OCSP не включены', 'Обновлено: 28fb95e, 6fbc639'],
    ['spring-cloud-gateway-server(-webflux)', 'CVE-2025-41243 (C, CVSS 10.0), CVE-2025-41253', '4.3.0 → **4.3.5**', 'Транзитивная (spring-cloud-starter-gateway-server-webflux)', 'Нет: обе — SpEL через actuator gateway/изменение маршрутов; наружу только health на порту 8079 внутри сети', 'Обновлено: 28fb95e'],
    ['bcprov-jdk18on', 'CVE-2025-14813 (C), CVE-2026-13506', '1.78.1/1.80/1.81 → **1.87**', 'Прямая в auth-service; транзитивная в шлюзе (spring-cloud) и applications-service (minio)', 'Нет: в auth-service — только Argon2id; GOSTCTR и разбор ASN.1 от клиента не вызываются', 'Обновлено (28fb95e), одна версия во всех модулях'],
    ['netty-* (codec, handler, codec-http, -http2, -dns)', 'CVE-2026-33870, -33871, -42579, -42583, -42584, -42587; после Boot — -75595 (C), -59901', '4.1.127 → **4.1.141**', 'Транзитивная (gateway-server-webflux; lettuce в data-redis)', 'Частично: HTTP/1.1-сервер шлюза (CVE-2026-33870) достижим; HTTP/2 не включён; TLS шлюза — JDK, не SNI-маршрутизация Netty', 'Обновлено (28fb95e, 6fbc639)'],
    ['jackson-core / jackson-databind', 'CVE-2026-54512, -54513, -68494, -68497, -89407, -89425, -91776, -91777', '2.19.2 → **2.21.9**', 'Транзитивная (starter-web, jackson-module-kotlin из platform)', 'Да для DoS: любой разбор тела JSON. RCE (-54512/-54513) требует полиморфной десериализации — не включена', 'Обновлено: 28fb95e, 4410ddd'],
    ['kafka-clients', 'CVE-2026-35554', '3.9.1 → **3.9.2**', 'Транзитивная (spring-kafka)', 'Да: продюсеры и потребитель', 'Обновлено (28fb95e через BOM Spring Boot)'],
    ['lz4-java', 'CVE-2025-12183, -66566, CVE-2026-106451', 'org.lz4 1.8.0 → **at.yawk.lz4 1.14.1**', 'Транзитивная (kafka-clients)', 'Нет: compression.type не задан; сжатые пакеты могли бы прислать только свои сервисы (ACL Kafka)', 'Обновлено (28fb95e, 6fbc639)'],
    ['snappy-java', 'CVE-2026-108106', '1.1.10.5/7 → **1.1.10.12**', 'Транзитивная (kafka-clients, minio)', 'Нет: см. lz4', 'Обновлено (28fb95e)'],
    ['spring-kafka', 'CVE-2026-41731', '3.3.10 → **3.3.16**', 'Прямая', 'Нет: StringDeserializer и Jackson в заданные классы; JsonDeserializer с заголовками типов не используется', 'Обновлено (28fb95e через BOM Spring Boot)'],
    ['spring-webmvc / -webflux / -expression', 'CVE-2026-41842, -41845, -41850; после — **CVE-2026-47884, -47890, -47892 (C)**', '6.2.11 → **6.2.19**; исправление только в 7.0.9', 'Транзитивная (starter-web, gateway)', '**Нет**: XsltView и представления, SSE с фрагментами представлений, функциональные WebFlux-эндпоинты, статические ресурсы и SpEL из ввода не используются — только @RestController', 'Обновлено до 6.2.19 (28fb95e); **остаток оставлен** (переход на Spring 7 = Spring Boot 4, смена мажорной версии)'],
    ['spring-boot', 'CVE-2026-40973', '3.5.6 → **3.5.16**', 'Транзитивная (стартеры)', 'Нет: нужен локальный доступ к контейнеру (AV:L)', 'Обновлено (28fb95e)'],
    ['spring-data-commons, micrometer-core', 'CVE-2026-41695, -41716; CVE-2026-40983, -40984', '3.5.4 → 3.5.13; 1.15.4 → 1.15.12', 'Транзитивная (data-redis, actuator)', 'Нет: репозитории Spring Data, gRPC и Jetty-метрики не используются', 'Обновлено (28fb95e через BOM Spring Boot)'],
    ['postgresql (pgjdbc)', 'CVE-2026-42198; после — CVE-2026-54291', '42.7.7 → **42.7.15**', 'Прямая (runtimeOnly)', 'Нет: уязвим клиент при вредоносном сервере; сервер — свой PostgreSQL', 'Обновлено (28fb95e, 6fbc639)'],
    ['minio', 'CVE-2025-59952', '8.5.17 → **8.6.0**', 'Прямая', 'Нет: XML приходит от собственного хранилища', 'Обновлено (28fb95e)'],
    ['guava', 'CVE-2026-102554', '33.3.1 → **33.8.0**', 'Транзитивная (minio)', 'Нет: внутри minio, без пользовательских данных', 'Обновлено (28fb95e)'],
    ['Go-библиотеки SeaweedFS (stdlib 1.24.6, x/crypto, x/net, grpc, pgx, go-jose, otel)', '8 Critical, 79 High (CVE-2025-68121, CVE-2026-33186, -33815, -33816 и др.)', 'SeaweedFS 3.97 → **4.55**', 'Компонент образа хранилища', 'Частично: net/http достижим через S3 API из браузера; TLS, SSH, pgx, gRPC-authz не используются', 'Обновлено: 4396a54 (0 High/Critical)'],
  ], [14, 20, 13, 15, 22, 16], 17),
  H2('4.4. Сторонние образы и что оставлено без обновления'),
  p('Пакеты ОС собственных образов обновлены сменой базового образа (nginx 1.30.8 + `apk upgrade`, SeaweedFS 4.55, свежий eclipse-temurin:21-jre-alpine при `build --pull`). Для сторонних образов выбраны последние выпуски тех же веток, а оставшиеся уязвимости обоснованы:'),
  bullet('**osixia/openldap:1.5.0** (Debian 10, EOL). В итоговом скане 467 High/Critical по пакетам образа. Это учебная замена университетского каталога R-09. Порт не публикуется, приложение выполняет поиск с учётной записью только для чтения. Эти условия ограничивают доступ, но не устанавливают достижимость отдельных CVE. Замена образа требует проверки переноса LDAP-конфигурации и регрессии поиска.'),
  bullet('**apache/kafka:3.9.2** — последний выпуск ветки 3.9. Остаток — библиотеки самого Kafka (Jetty REST Connect, ZooKeeper-клиент, jline консольных утилит, Jackson, Netty) и пакеты ОС (gnutls, curl, expat). В режиме KRaft брокер не запускает Connect и ZooKeeper, утилиты не используются в работе, сетевой доступ — только SASL-листенер во внутренней сети. Переход на Kafka 4.x — смена мажорной версии брокера, вынесен в план.'),
  bullet('**kafbat/kafka-ui:v1.5.1**, **liquibase 4.33.0**, **postgres:16.16-alpine** — Critical в Spring Framework 6.2.19 у kafka-ui (недостижим, см. 4.3; интерфейс теперь только со входом), Go stdlib в gosu у postgres (используется только в entrypoint для смены пользователя), Jackson/mssql-jdbc/Go у liquibase (одноразовый контейнер миграций, завершается до старта сервисов, вход только из файлов репозитория). Обновятся с выходом новых выпусков образов.'),
  bullet('**Spring Framework 6.2.19** в сервисах — см. таблицу 4.3: исправление только в 7.0.9 (Spring Boot 4), уязвимые функции не используются.'),
  p('Дополнение after/sca-residual-review.csv содержит решение по каждой из 642 остаточных записей, цель Trivy, заголовок бюллетеня и ссылку. Для 10 записей Spring Framework в собственных образах приведён вывод по конкретному CVE и соответствующему механизму приложения. Для 632 записей инфраструктурных образов описаны условия развёртывания и причина, по которой риск оставлен. Прямой вызов из кода проекта отсутствует, а использование затронутой функции внутри стороннего образа не установлено. Эти записи остаются открытыми для индивидуальной проверки достижимости.'),
  H2('4.5. CVE, CWE и CVSS на примере находки'),
  p('**CVE-2025-41243** (spring-cloud-gateway-server-webflux 4.3.0) — идентификатор конкретной уязвимости в конкретном продукте; **CWE-917** (Expression Language Injection) — класс ошибки; **CVSS 3.1 = 10.0** — оценка тяжести. Вектор `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H`: атака по сети (AV:N), низкая сложность (AC:L), привилегии не нужны (PR:N), участие пользователя не нужно (UI:N), область меняется — последствия выходят за пределы уязвимого компонента (S:C), полная потеря конфиденциальности, целостности и доступности (C:H/I:H/A:H). Достижимость у нас нулевая: эксплуатация требует доступа к actuator gateway, который не включён, — поэтому оценка 10.0 описывает компонент, а не нашу систему; обновили всё равно, так как это бесплатно в рамках ветки.'),
);

// ===== 5. DAST
const zrow = (ph, run, label) => [label, D[ph].zap[run] ? D[ph].zap[run].imported ?? '—' : '—', fmtZ(D[ph].zap[run])];
const manualRows = [
  ['A1', 'Проверочный запрос 1: чужой объект с действительным токеном → 404'], ['A2', 'Проверочный запрос 2: лишние поля status/applicant_id/role → 400'],
  ['A3', 'Проверочный запрос 3: реестр выплат токеном заявителя → 403'],
  ['B1–B7', 'Подпись чужим ключом, alg=none, HS256 с открытым ключом, изменённая роль, просроченный токен (верная подпись), несуществующая сессия, refresh вместо access → 401'],
  ['B8', 'Токен после выхода → 401'],
  ['C1–C7', 'Повторная отправка: два одновременных POST с одним Idempotency-Key → одна заявка; новый ключ → 409; без ключа → 400; два PATCH с одним If-Match → 200 и 409; реестр выплат с тем же ключом → тот же, с новым → 409; нет двойного начисления'],
  ['D1, D3–D7', 'HSTS, nosniff, XFO, no-store на шлюзе; нет Server; CORS для чужого Origin не разрешён; флаги cookie; заголовки nginx'],
  ['D2', 'CSP на ответах API'], ['D8', 'Заголовки на ответах хранилища вложений'],
  ['E1–E7', 'Ошибки 400/404/405/413/415 без стека, SQL и версий'],
  ['E8, E9', 'NUL-байт в строке JSON (password-reset, login) → 400, а не 500'],
  ['F1–F5', 'SQL в sort/status, подделанный курсор, LDAP-фильтр, HTML в перечислении'],
  ['G1–G4', 'Обход «..» и «..;» к /internal и чужой заявке, actuator через шлюз'],
  ['H1', 'Ограничение частоты на входе: 429 + Retry-After'], ['H2', 'Перебор пароля через OP-16 reauth'],
  ['I1', 'R-07 видит только статус'], ['I2–I4', 'Черновики не видны сотрудникам'], ['I5', 'OP-06 по чужой заявке → 404'],
  ['J1, J2', 'Kafka UI и Mailpit требуют входа'],
];
const mstat = (ph, ids) => {
  const list = ids.split(/,\s*/).flatMap(x => { const m = x.match(/^(\w)(\d+)–\w(\d+)$/); return m ? Array.from({ length: +m[3] - +m[2] + 1 }, (_, i) => m[1] + (+m[2] + i)) : [x]; });
  const st = list.map(i => D[ph].manual.byId[i]);
  const ok = st.filter(s => s === 'OK').length;
  return ok === list.length ? `OK (${ok})` : `**${list.length - ok} FAIL** из ${list.length}`;
};
add(
  H1('5. DAST — динамический анализ работающей системы'),
  H2('5.1. Настройка сканирования'),
  bullet('Все эндпоинты переданы сканеру импортом `docs/openapi.yaml`: 18 операций, примеры значений — идентификаторы из seed.sql, чтобы сканер обращался к существующим заявкам и кампаниям, а не получал только 404. ZAP импортировал 23 URL.'),
  bullet('**Прогон 1 — без аутентификации**: zap-api-scan (пассивное + активное сканирование, политика API). **Прогон 2 — с токеном обычного пользователя** stud001: хук `zap_auth_hook.py` входит через /auth/login (сертификат шлюза проверяется) и правилом Replacer добавляет `Authorization: Bearer …` ко всем запросам, обновляя токен каждые 4 минуты (срок токена 10 минут, сканирование дольше); OP-15 исключён, иначе сканер завершил бы собственную сессию. **Прогон 3** — zap-full-scan веб-кабинета (spider + пассивное + активное).'),
  bullet('Темп — 1 поток и 250 мс между запросами, чтобы не упираться в лимиты шлюза (300/мин на субъекта). Без аутентификации публичные операции входа, регистрации и восстановления быстро получают 429 — это видно в отчёте и означает, что активные проверки этих эндпоинтов частично отсечены лимитом (ложноотрицательные результаты сканера).'),
  T('ZAP: число находок High/Medium/Low/Informational'),
  table(['Прогон', 'URL из OpenAPI «до»', '«До»', '«После»'], [
    [...zrow('before', 'api-unauth', 'API без аутентификации'), fmtZ(A.zap['api-unauth'])],
    [...zrow('before', 'api-auth', 'API с токеном stud001'), fmtZ(A.zap['api-auth'])],
    ['Веб-кабинет (spider)', '—', fmtZ(B.zap['web-full']), fmtZ(A.zap['web-full'])],
  ], [34, 18, 24, 24]),
  p('Таблица показывает сохранённые прогоны исходной версии. Повторные активные прогоны ZAP на итоговой версии отсутствуют. Результаты ручной проверки и пассивного наблюдения на итоговой версии приведены отдельно.'),
  p('На итоговой версии ZAP 2.17.0 выполнил два пассивных прогона: гостевой и с сессией stud002. В каждом наблюдались четыре штатных GET-запроса к кабинету и API. Оба прогона завершились успешно. В каждом отчёте одно информационное сообщение Modern Web Application и ноль находок High, Medium и Low. Этот набор запросов имеет меньший охват, чем импорт OpenAPI в исходных прогонах.'),
  H2('5.2. Разбор находок ZAP'),
  T('Разбор находок DAST'),
  table(['ID', 'Инструмент, место и суть', 'Уровень', 'Вердикт и обоснование', 'Исправление'], [
    ['V-D05', 'ZAP 100000 (прогон без аутентификации): POST /api/v1/auth/password-reset → **500**', 'Low', '**Подтверждена.** По журналу auth-service: атака со строкой, содержащей U+0000; PostgreSQL отвечает «invalid byte sequence for encoding UTF8: 0x00». Ответ клиенту нейтральный (без стека), но ошибка клиента выглядит как сбой сервиса; то же для login, statement, reason (ручные проверки E8, E9 «до» → 500)', 'a5af2e4: 400 на разборе JSON во всех сервисах'],
    ['V-D06', 'ZAP 100000 (прогон с токеном): GET/POST …/completeness-check → 501', 'Low', '**Ложное.** 501 Not Implemented — намеренная заглушка OP-06/OP-11 (журнал расхождений D-03); ZAP относит любой 5xx к ошибкам сервера', 'Не требуется'],
    ['V-D01', 'ZAP 90004 Cross-Origin-Resource-Policy (API); ручная D2 — нет CSP у ответов API', 'Low', '**Подтверждена.** Ответ API, открытый в браузере по прямой ссылке, не ограничен CSP; чужой сайт мог встроить ответ', '35d7bd0'],
    ['V-D02', 'ZAP 10063 Permissions-Policy, 90004 COOP/COEP/CORP (веб-кабинет)', 'Low', '**Подтверждена** (усиление защиты): нет запрета API устройств и изоляции окна от чужих сайтов', 'cc827bb, 98d2d93'],
    ['V-D07', 'ZAP 10049 Non-Storable/Storable Content, 10015 Re-examine Cache-control, 10111 Authentication Request Identified, 10109 Modern Web Application', 'Info', '**Информационные.** Ответы API — no-store (намеренно); статика SPA кэшируется (не содержит данных); вход определён верно', 'Не требуется'],
    ['V-D03', 'Ручная J1: Kafka UI на 127.0.0.1:8090 без входа', 'High', '**Подтверждена.** GET /api/clusters → 200; в топике auth.password-reset — одноразовые коды восстановления в открытом виде: любой процесс или пользователь машины мог сменить пароль любой учётной записи. ZAP этот интерфейс не сканировал — он вне API', 'aa20549'],
    ['V-D04', 'Ручная J2: Mailpit на 127.0.0.1:8025 без входа', 'High', '**Подтверждена** — тот же захват учётной записи через письмо со ссылкой восстановления', '7e583ab'],
  ], [7, 30, 8, 40, 15], 18),
  H2('5.3. Ручные проверки на живой системе'),
  p(`Скрипт \`requests/lab5-manual-checks.mjs\` отправляет сырые запросы (путь уходит без нормализации, что нужно для проверок «..»), и для каждой проверки описывает безопасное поведение. «До»: **успешно ${B.manual.ok}, находок ${B.manual.fail}**; «после»: **успешно ${A.manual.ok}, находок ${A.manual.fail}**. Журналы — \`docs/lab5/{before,after}/manual-checks.txt\`.`),
  T('Ручные проверки до и после'),
  table(['ID', 'Проверка', '«До»', '«После»'], manualRows.map(([id, name]) => [id, name, mstat('before', id), mstat('after', id)]), [10, 60, 15, 15], 18),
  H2('5.4. Заголовки, CORS, cookie, ошибки, инъекции'),
  bullet('**Заголовки безопасности.** Шлюз «до» уже ставил HSTS, nosniff, X-Frame-Options: DENY, Cache-Control: no-store и не раскрывал Server; не хватало CSP и CORP (V-D01). Клиенты nginx: CSP без inline-скриптов, nosniff, XFO, Referrer-Policy, `server_tokens off`; дефекты — потеря заголовков на ответах хранилища (V-S01) и отсутствие Permissions-Policy/COOP/COEP/CORP (V-D02).'),
  bullet('**CORS.** Шлюз CORS не настраивает: предварительный запрос с Origin https://evil.example → 403 без Access-Control-Allow-Origin; браузерные клиенты обращаются к API через прокси своего origin, поэтому межсайтовый доступ не нужен.'),
  bullet('**Cookie.** Единственная cookie — refresh_token: HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth; Max-Age = остаток сессии (8 ч).'),
  bullet('**Ошибки.** Битый JSON, неверный тип, 405, 413, 415, неверный UUID — нейтральный JSON с request_id без стека и SQL. Единственный 500 — V-D05 (исправлена). Неизвестный путь на шлюзе отдаёт стандартный JSON Spring WebFlux (timestamp, path, status) — без внутренних подробностей, оставлено.'),
  bullet('**Инъекции.** ZAP: SQL-инъекции (в т. ч. по времени), XSS, внедрение команд, SSTI, обход пути — PASS во всех трёх прогонах. Ручные: SQL в sort/status (400 без задержки pg_sleep), подделанный курсор, LDAP-фильтр — 400. Это подтверждает решения ЛР № 3: параметризованный SQL, белые списки сортировок, параметризованный LDAP-фильтр.'),
  H2('5.5. Что нашёл сканер, а что только ручная проверка'),
  p('Ни один из трёх проверочных запросов ЛР № 2/3 ZAP как уязвимость не отметил — потому что система их отбивает, — но и проверить их сам он бы не смог. Запрос 1 (чужая заявка) требует знать, что e02 принадлежит другому пользователю: сканер с одним токеном видит 404 и не может отличить «чужая» от «нет такой». Запрос 2 (лишние поля) — ZAP подставляет атаки в существующие параметры, но не добавляет поля status/applicant_id/role и не сверяет строку в БД. Запрос 3 (реестр выплат токеном заявителя) — сканер получил 403, но не знает, что для этой роли 403 — правильный ответ, а 201 был бы уязвимостью. Только ручной разбор нашёл все нарушения контроля доступа (V-M01…V-M04) и открытые служебные интерфейсы (V-D03, V-D04); ZAP нашёл ошибку обработки ввода (V-D05) и недостающие заголовки, которые вручную легко пропустить.'),
);

// ===== 6. До и после
const zsum = (z) => z ? z.High + z.Medium + z.Low : '—';
add(
  H1('6. Сравнение результатов «до» и «после»'),
  p('Для сравнения использованы сохранённые результаты статического анализа и ручной регрессии, а также повторная проверка 15 локальных образов Trivy с кэшированной базой. Сравнение ZAP на одинаковом наборе активных профилей остаётся открытым.'),
  p('Дополнительная проверка SAST выполнена на снимке git archive коммита 6fbc639. Semgrep 1.186.0 проверил 112 файлов и повторил четыре WARNING из исходного отчёта «после». В протоколе есть две диагностические записи по разбору docs/openapi.yaml и gradlew. Trivy проверил восемь Dockerfile: восемь LOW с одним ID DS-0026, High и Critical отсутствуют. Gitleaks повторно проверил дерево этого коммита с вердиктом 0 находок. Оригиналы дополнительных проверок сохранены отдельно с суффиксом -verified.'),
  p(verifiedSpotBugs ? `SpotBugs и FindSecBugs повторно проверили все шесть модулей точного снимка; приоритеты 1 / 2 / 3 — ${verifiedSpotBugs.priorities.join(' / ')}. Исходные XML, SARIF и HTML лежат в after/spotbugs-verified.` : 'Повторный SpotBugs на точном снимке коммита не подтверждён. В таблице приведён ранее сохранённый прогон.'),
  T('Результаты до и после'),
  table(['Вид', 'Инструмент / показатель', '«До»', '«После»', 'Пояснение'], [
    ['SAST', 'Semgrep: ERROR / WARNING', `${B.semgrep.ERROR} / ${B.semgrep.WARNING}`, `${A.semgrep.ERROR} / ${A.semgrep.WARNING}`, 'Остались V-S06 (2, ложное) и 2 ложных в новых файлах ЛР5: тестовая строка `<script>` в ручной проверке F5 и URL из переменной окружения в хуке ZAP'],
    ['SAST', 'SpotBugs: приоритет 1 / 2 / 3', `${sb('before').byPrio[1]} / ${sb('before').byPrio[2]} / ${sb('before').byPrio[3]}`, `${sb('after').byPrio[1]} / ${sb('after').byPrio[2]} / ${sb('after').byPrio[3]}`, 'Ушёл SPRING_CSRF (V-S04); добавились SE_NO_SERIALVERSIONID нового десериализатора и SPRING_ENDPOINT второго метода completeness — ложные/информационные'],
    ['SAST', 'Trivy config: HIGH / LOW', `${B.trivyConfig.HIGH} / ${B.trivyConfig.LOW}`, `${A.trivyConfig.HIGH} / ${A.trivyConfig.LOW}`, 'Все контейнеры без root; DS-0026 — ложное (V-S14)'],
    ['SAST', 'gitleaks: история / итоговое дерево', `${B.gitleaks} / —`, `${A.gitleaks} / ${A.gitleaksHead}`, 'В истории остаются тестовые пароли старых коммитов (V-S02, неактуальны); дерево — 0'],
    ['SCA', 'High+Critical, все образы', sumHC(B.images), sumHC(A.images), 'Единица подсчёта — находка в образе. Один CVE может встречаться в нескольких образах.'],
    ['SCA', 'High+Critical, собственные образы', sumHC(B.images, ours), sumHC(A.images, ours), 'Остаток по пакетам и образам приведён в итоговом CSV.'],
    ['SCA', 'Critical, собственные образы', sumSev(B.images, 'CRITICAL', ours), sumSev(A.images, 'CRITICAL', ours), ''],
    ['DAST', 'ZAP High+Medium+Low (3 прогона)', zsum(B.zap['api-unauth']) + zsum(B.zap['api-auth']) + zsum(B.zap['web-full']), [A.zap['api-unauth'], A.zap['api-auth'], A.zap['web-full']].every(Boolean) ? zsum(A.zap['api-unauth']) + zsum(A.zap['api-auth']) + zsum(A.zap['web-full']) : '—', 'См. 5.2'],
    ['DAST', 'Ручные проверки: OK / находки', `${B.manual.ok} / ${B.manual.fail}`, `${A.manual.ok} / ${A.manual.fail}`, ''],
    ['Регрессия', 'run-all.mjs (ЛР № 3)', '149 / 0', A.runAll ? `${A.runAll[0]} / ${A.runAll[1]}` : '—', 'Функциональность не нарушена'],
  ], [10, 25, 11, 11, 43], 18),
  p('Исправления контроля доступа, конфигурации контейнеров, обработки ошибок и зависимостей перечислены по коммитам. Оставшиеся находки в компонентах отражены в итоговом CSV. Без повторного активного прогона ZAP нельзя подтвердить устранение всех динамических находок на одинаковом охвате.'),
);

// ===== 7. Выводы
add(
  H1('7. Выводы'),
  p('SAST (Semgrep, SpotBugs+FindSecBugs, Trivy config, gitleaks) нашёл ошибки конфигурации — запуск контейнеров от root и потерю заголовков в nginx — и тестовые пароли в истории, а почти все находки в коде Kotlin оказались ложными: параметризованный SQL и LDAP, проверенные токены и UUID в журналах. SCA дал самый большой объём — 1 281 уязвимость High/Critical в 15 образах, в том числе Critical в Tomcat и Spring Cloud Gateway; большая часть закрыта обновлением в пределах тех же веток, остаток обоснован недостижимостью или тем, что образ — локальная заглушка. DAST (ZAP) нашёл то, что видно только на работающей системе: 500 на NUL-байте и недостающие заголовки ответов, а ручные проверки подтвердили, что токены, идемпотентность и лимиты работают.'),
  p('Ни один инструмент не нашёл нарушений контроля доступа — R-07 видит сведения о здоровье, сотрудники видят черновики, перебор пароля через повторную аутентификацию, открытые Kafka UI и Mailpit: для этого нужно знать модель ролей и владельцев из ЛР № 1–2, которой у сканера нет. Их нашёл только ручной разбор карты кода по проектным правилам, поэтому проверки прав на объект и роль должны быть в автоматических тестах (как в run-all.mjs и lab5-manual-checks.mjs), а не ожидаться от сканеров.'),
);

// ===== Приложение А
add(
  H1('Приложение А. Исходные отчёты и SBOM'),
  p('Все файлы лежат в репозитории (ветка lab5) и прикладываются к отчёту отдельно:'),
  table(['Файл', 'Содержание'], [
    ['`docs/lab5/{before,after}/semgrep.sarif`, `semgrep.json`', 'Semgrep'],
    ['`docs/lab5/{before,after}/spotbugs/*.sarif|html|xml`', 'SpotBugs + FindSecBugs по 6 модулям'],
    ['`docs/lab5/{before,after}/trivy-config.json`', 'Trivy config (Dockerfile)'],
    ['`docs/lab5/before/gitleaks-history.json`, `after/gitleaks-history.json`, `after/gitleaks-head.json`', 'gitleaks: вся история и итоговое дерево'],
    ['`docs/lab5/{before,after}/trivy/*.json`', 'Trivy по 15 образам'],
    ['`docs/lab5/{before,after}/sbom/*.cdx.json`', 'SBOM CycloneDX 1.7'],
    ['`docs/lab5/{before,after}/sca-high-critical.csv`', 'Каждая уязвимость High/Critical с полями задания 2.4'],
    ['`docs/lab5/{before,after}/deps-*.txt`', 'Деревья зависимостей Gradle'],
    ['`docs/lab5/before/zap/*`', 'Исходные прогоны ZAP: API без аутентификации, API с токеном, веб-кабинет'],
    ['`docs/lab5/after/zap-passive/*`', 'Повторная пассивная проверка на штатных запросах'],
    ['`docs/lab5/{before,after}/manual-checks.txt`, `after/run-all.txt`', 'Ручные проверки и регрессия'],
    ['`docs/openapi.yaml`, `tools/`', 'Спецификация для ZAP и скрипты запуска инструментов'],
  ], [55, 45], 20),
);

// ===== Приложение Б — к защите
add(
  H1('Приложение Б. Ответы на вопросы к защите'),
  p('**1. SAST, DAST, SCA.** SAST читает код без запуска (видит опасные вызовы и поток данных, не видит конфигурацию окружения и логику прав) — при коммите и в IDE. SCA сверяет состав зависимостей и образов с базами CVE (видит известные уязвимости чужого кода, не видит ошибок своего) — при сборке и постоянно по SBOM. DAST атакует работающую систему (видит реальные ответы, заголовки, ошибки, не видит код и недоступные пути) — на тестовом стенде перед выпуском.'),
  p('**2. FP и FN.** Ложное срабатывание — находка, которой нет (V-S07 LDAP), пропуск — уязвимость, которую инструмент не нашёл (V-M01). SAST склонен к FP, DAST — к FN (видит только то, до чего дошёл; лимиты отсекают проверки), SCA — к FP по достижимости. Опаснее FN: он создаёт ложную уверенность.'),
  p('**3. IDOR/BOLA и сканеры.** Сканер не знает, кому принадлежит объект и какой ответ правилен для роли: 404 на чужую заявку и 404 на несуществующую для него одинаковы, а 200 на свою — норма. Нужны два пользователя и модель владения — это делают тесты и ручные проверки.'),
  p('**4. CVE, CWE, CVSS** — см. раздел 4.5.'),
  p('**5. Транзитивная зависимость** — пришедшая через объявленную (Tomcat через spring-boot-starter-web). Её код выполняется в нашем процессе, поэтому уязвимость в ней — наша. Достижимость — вызывается ли уязвимая функция на путях, куда доходит ввод атакующего (lz4 — нет, Jackson — да).'),
  p('**6. SBOM** — перечень всех компонентов поставки с версиями и purl. Заказчику — оценить риски и ответить на новую CVE без доступа к коду, разработчику — найти, где используется уязвимый компонент.'),
  p('**7. Пассивное и активное.** Пассивное только анализирует проходящий трафик; активное отправляет атаки (SQL, обход пути, изменение данных — ZAP отзывал заявки и создавал записи). Против чужой или промышленной системы — это вмешательство в чужие данные и работу, без разрешения незаконно.'),
  p('**8. Сканирование с аутентификацией** — без токена сканер видит только 401 (прогон 1). Токен передаётся заголовком через Replacer/скрипт ZAP с обновлением (наш хук) или контекстом аутентификации ZAP.'),
  p('**9. IAST** — агент внутри работающего приложения следит за потоком данных во время DAST/тестов: видит и запрос, и строку кода; меньше FP, чем SAST, и глубже, чем DAST, но требует инструментирования.'),
  p('**10. CI/CD.** На коммит — gitleaks и SAST (останавливают сборку новые High и любые секреты); на сборку — SCA образов и SBOM (Critical/High с исправлением и достижимостью — стоп); на стенде — DAST базовый на каждом выпуске, активный — по расписанию; конфигурация gitleaks этого репозитория уже готова к CI.'),
  p('**По работе.** Ложное срабатывание — V-S07 (раздел 3.2). Самая серьёзная подтверждённая — V-D03/V-D04: код восстановления из Kafka UI → смена пароля любого пользователя; исправлено обязательным входом, полно — оба интерфейса закрыты, а коды по-прежнему одноразовые и живут 15 минут. Не обновлена — Spring Framework 6.2.19 (раздел 4.3). Секреты: в истории только тестовые пароли стенда; при утечке настоящего секрета — сначала отозвать/сменить его, затем при необходимости переписать историю (filter-repo) и принудительно обновить все копии. В проекте ЛР № 2 стоило бы прописать в контрактах права на поля объекта для каждой роли (а не только на объект) и требования к служебным интерфейсам стенда.'),
);

// ------------------------------------------------------------------ содержание
const tocPages = fs.existsSync(path.join(OUT, 'toc.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'toc.json'), 'utf8')) : {};
const tocItems = HEADS.map(([lvl, s]) => new Paragraph({
  spacing: { line: 300 }, indent: { left: lvl === 2 ? 425 : 0 },
  tabStops: [{ type: 'right', position: PAGE_W, leader: 'dot' }],
  children: [t(s, { size: 26 }), new TextRun({ children: [new Tab(), String(tocPages[s] || '00')], font: FONT, size: 26 })],
}));
children.splice(TOC_AT, 0, ...tocItems);
fs.writeFileSync(path.join(OUT, 'heads.json'), JSON.stringify(HEADS.map(h => h[1])));

const doc = new Document({
  creator: 'Чикилев М.А.', title: 'Отчёт по ЛР №5', description: 'Проверка защищённости реализации: SAST, DAST, SCA',
  styles: {
    default: { document: { run: { font: FONT, size: 28 } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: FONT, size: 32, bold: true }, paragraph: { spacing: { before: 240, after: 240 }, keepNext: true, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { font: FONT, size: 28, bold: true }, paragraph: { spacing: { before: 240, after: 120 }, keepNext: true, outlineLevel: 1 } },
    ],
  },
  numbering: { config: [{ reference: 'bul', levels: [{ level: 0, format: LevelFormat.BULLET, text: '–', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 709, hanging: 283 } } } }] }] },
  sections: [{
    properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1701, right: 850 } }, titlePage: true },
    footers: {
      default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 24 })] })] }),
      first: new Footer({ children: [new Paragraph({ children: [] })] }),
    },
    children,
  }],
});
Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync(path.join(OUT, 'report.docx'), buf);
  console.log('docx', buf.length);
});
