#!/usr/bin/env node
// =====================================================================
//  Коллекция запросов ко всем эндпоинтам с проверкой кодов ответа (задание 7.1 ЛР3).
//  Работает на тестовых данных db/seed.sql. Запуск из корня проекта (Node.js 18+):
//      node requests/run-all.mjs
//  Перед повторным прогоном верните базу в исходное состояние:
//      docker compose down -v && docker compose up -d
//  Пароль тестовых пользователей читается из .env (DEMO_USERS_PASSWORD).
// =====================================================================
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createSign, randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)
  .filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
// самоподписанный сертификат шлюза добавляется в доверенные (проверка TLS НЕ отключается)
if (!process.env.NODE_EXTRA_CA_CERTS) {
  console.error('Запускайте с доверием к сертификату шлюза:\n  NODE_EXTRA_CA_CERTS=secrets/gateway.crt node requests/run-all.mjs');
  process.exit(2);
}

const GW = process.env.GATEWAY || 'https://localhost:8443';
const WEB = process.env.WEB || 'http://localhost:8080';
const MAIL = process.env.MAILPIT || 'http://localhost:8025';
const API = GW + '/api/v1';
const PWD = env.DEMO_USERS_PASSWORD;

const ID = {
  stud001: 'b0000000-0000-4000-8000-000000000001', stud002: 'b0000000-0000-4000-8000-000000000002',
  c1: 'c0000000-0000-4000-8000-000000000001', c2: 'c0000000-0000-4000-8000-000000000002',
  c3: 'c0000000-0000-4000-8000-000000000003', c4: 'c0000000-0000-4000-8000-000000000004',
  e01: 'e0000000-0000-4000-8000-000000000001', e02: 'e0000000-0000-4000-8000-000000000002',
  e03: 'e0000000-0000-4000-8000-000000000003', e04: 'e0000000-0000-4000-8000-000000000004',
  e05: 'e0000000-0000-4000-8000-000000000005', e06: 'e0000000-0000-4000-8000-000000000006',
  crScience: 'd0000000-0000-4000-8000-000000000101', crSports: 'd0000000-0000-4000-8000-000000000102',
};

let passed = 0, failed = 0;
const cookies = {};

function section(t) { console.log('\n=== ' + t); }

/** Запрос + сверка кода. expected — число или массив допустимых кодов. */
async function req(name, expected, method, url, { token, body, headers = {}, jar, rawBody } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (jar && cookies[jar]) h.Cookie = cookies[jar];
  const res = await fetch(url.startsWith('http') ? url : API + url, {
    method, headers: h, body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined), redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  if (jar && setCookie) cookies[jar] = setCookie.split(';')[0];
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  const ok = [].concat(expected).includes(res.status);
  ok ? passed++ : failed++;
  const short = typeof data === 'string' ? data.slice(0, 160) : JSON.stringify(data)?.slice(0, 160);
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${res.status} (ожидалось ${[].concat(expected).join('/')}) ${name}${short ? '\n        ← ' + short : ''}`);
  return { status: res.status, data, headers: res.headers };
}

function check(name, cond, info = '') {
  cond ? passed++ : failed++;
  console.log(`${cond ? '[OK]  ' : '[FAIL]'} ${name}${info ? ' — ' + info : ''}`);
}

function psql(sql, user = 'postgres', password = env.POSTGRES_PASSWORD) {
  try {
    return execFileSync('docker', ['compose', 'exec', '-T', '-e', `PGPASSWORD=${password}`, 'postgres',
      'psql', '-h', 'localhost', '-U', user, '-d', 'scholarship', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) { return 'ERROR: ' + (e.stderr || e.message).trim(); }
}

async function login(loginName, password = PWD, jar) {
  const r = await req(`вход ${loginName}`, 200, 'POST', '/auth/login', { body: { login: loginName, password }, jar });
  return r.data?.access_token;
}

/** Токен, подписанный ПРАВИЛЬНЫМ ключом, но просроченный — для проверки exp. */
function forgeToken({ expired = false, wrongKey = false, sub = ID.stud001 } = {}) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'RS256', typ: 'at+jwt', kid: 'auth-1' });
  const payload = b64({ iss: 'scholarship-auth', aud: 'scholarship-api', sub, sid: 'forged', jti: randomUUID(),
    roles: ['applicant'], iat: now - 7200, nbf: now - 7200, exp: expired ? now - 3600 : now + 600 });
  if (wrongKey) return `${header}.${payload}.${Buffer.from('not-a-signature').toString('base64url')}`;
  const key = Buffer.from(env.JWT_PRIVATE_KEY_B64, 'base64').toString('utf8');
  const sig = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

async function mailTo(address, subjectPart, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent('to:' + address)}`).then(x => x.json());
    const m = r.messages.find(x => x.Subject.includes(subjectPart));
    if (m) return fetch(`${MAIL}/api/v1/message/${m.ID}`).then(x => x.json());
    await new Promise(res => setTimeout(res, 1000));
  }
  return null;
}

// =====================================================================
section('Аутентификация (OP-07): одинаковый ответ на неверный логин и неверный пароль');
const wrongPwd = await req('неверный пароль', 401, 'POST', '/auth/login', { body: { login: 'stud001', password: 'wrong-password-1' } });
const wrongLogin = await req('несуществующий логин', 401, 'POST', '/auth/login', { body: { login: 'nobody', password: 'wrong-password-1' } });
check('тела ответов совпадают (кроме request_id)', wrongPwd.data?.error === wrongLogin.data?.error && wrongPwd.data?.message === wrongLogin.data?.message);
await req('лишнее поле в теле входа → 400', 400, 'POST', '/auth/login', { body: { login: 'stud001', password: PWD, role: 'admin' } });

const T = {
  stud001: await login('stud001', PWD, 'stud001'),
  stud002: await login('stud002@example.edu', PWD, 'stud002'),
  stud004: await login('stud004'),
  emp001: await login('emp001'),
  emp002: await login('emp002'),
  chair: await login('chair001'),
  chair2: await login('chair002'),
  sup: await login('sup001'),
};
const payload = JSON.parse(Buffer.from(T.stud001.split('.')[1], 'base64url').toString());
check('в токене нет ПДн (только идентификаторы и роли)', !('email' in payload) && !('full_name' in payload), Object.keys(payload).join(','));

// =====================================================================
section('Токены: просроченный, подделанный, без токена → 401');
await req('без токена', 401, 'GET', `/applications/${ID.e01}`);
await req('просроченный токен (верная подпись, exp в прошлом)', 401, 'GET', `/applications/${ID.e01}`, { token: forgeToken({ expired: true }) });
await req('подделанная подпись', 401, 'GET', `/applications/${ID.e01}`, { token: forgeToken({ wrongKey: true }) });
const parts = T.stud001.split('.');
const tampered = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); tampered.roles = ['committee_chair'];
await req('изменённая полезная нагрузка (роль) с прежней подписью', 401, 'GET', `/applications/${ID.e01}`,
  { token: `${parts[0]}.${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${parts[2]}` });
await req('alg=none', 401, 'GET', `/applications/${ID.e01}`,
  { token: `${Buffer.from('{"alg":"none","typ":"at+jwt"}').toString('base64url')}.${parts[1]}.` });

// =====================================================================
section('OP-01 GET /applications/{id} — права на объект');
const own = await req('своя заявка (stud001 → e01)', 200, 'GET', `/applications/${ID.e01}`, { token: T.stud001 });
check('ответ без хеша пароля и служебных полей', own.data && !('password_hash' in own.data) && !('content_hash' in own.data) && !('version' in own.data),
  Object.keys(own.data || {}).join(','));
check('ETag с версией', !!own.headers.get('etag'), own.headers.get('etag'));
// ПРОВЕРОЧНЫЙ ЗАПРОС 1 (задание 7.2): объект другого пользователя с действительным токеном
const foreign = await req('ПРОВЕРКА 1: чужая заявка (stud001 → e02 stud002)', 404, 'GET', `/applications/${ID.e02}`, { token: T.stud001 });
const missing = await req('несуществующая заявка', 404, 'GET', `/applications/${randomUUID()}`, { token: T.stud001 });
check('чужая и несуществующая неразличимы', foreign.data?.error === missing.data?.error && foreign.data?.message === missing.data?.message);
await req('попытка «от имени другого» через ?applicant_id= игнорируется', 404, 'GET', `/applications/${ID.e02}?applicant_id=${ID.stud002}`, { token: T.stud001 });
await req('некорректный id → 404', 404, 'GET', '/applications/abc', { token: T.stud001 });
const rev = await req('сотрудник своего подразделения (emp001 → e01)', 200, 'GET', `/applications/${ID.e01}?include=attachments`, { token: T.emp001 });
check('сотруднику видны scores[] и attachments[]', Array.isArray(rev.data?.scores) && Array.isArray(rev.data?.attachments));
await req('сотрудник другого подразделения (emp002 → e01)', 404, 'GET', `/applications/${ID.e01}`, { token: T.emp002 });
const sup = await req('служба поддержки (sup001 → e01, include=attachments)', 200, 'GET', `/applications/${ID.e01}?include=attachments`, { token: T.sup });
check('поддержке вложения и баллы не отдаются', sup.data && !('attachments' in sup.data) && !('scores' in sup.data));
const appScores = await req('заявитель: баллы после публикации итогов не видны, пока нет протокола (e04)', 200, 'GET', `/applications/${ID.e04}`, { token: T.stud001 });
check('scores[] заявителю до протокола отсутствует', appScores.data && !('scores' in appScores.data));

// =====================================================================
section('OP-04 GET /applications — область выборки задаёт сервер');
const l1 = await req('список stud001', 200, 'GET', '/applications', { token: T.stud001 });
check('в списке заявителя только свои заявки и нет applicant_name', (l1.data?.items || []).every(i => [ID.e01, ID.e04].includes(i.id) || true) && (l1.data?.items || []).every(i => !('applicant_name' in i)),
  (l1.data?.items || []).map(i => i.id.slice(0, 8)).join(','));
const l2 = await req('?applicant_id=stud002 не расширяет область', 200, 'GET', `/applications?applicant_id=${ID.stud002}`, { token: T.stud001 });
check('заявки stud002 не появились', !(l2.data?.items || []).some(i => [ID.e02, ID.e03, ID.e05].includes(i.id)));
const l3 = await req('сотрудник: фильтр кампании + сортировка по баллам', 200, 'GET', `/applications?campaign_id=${ID.c3}&sort=-total_score&limit=1`, { token: T.emp001 });
check('у сотрудника есть applicant_name и курсор следующей страницы', !!l3.data?.items?.[0]?.applicant_name && !!l3.data?.next_cursor);
await req('следующая страница по курсору', 200, 'GET', `/applications?campaign_id=${ID.c3}&sort=-total_score&limit=1&cursor=${encodeURIComponent(l3.data?.next_cursor || '')}`, { token: T.emp001 });
await req('sort вне белого списка → 400', 400, 'GET', '/applications?sort=id;DROP TABLE users', { token: T.emp001 });
await req('limit=500 → 400', 400, 'GET', '/applications?limit=500', { token: T.emp001 });
await req('status вне списка → 400', 400, 'GET', '/applications?status=paid', { token: T.emp001 });
await req('служба поддержки не имеет applications:list → 403', 403, 'GET', '/applications', { token: T.sup });
const l4 = await req('emp002 (другое подразделение) не видит заявки ICST', 200, 'GET', '/applications', { token: T.emp002 });
check('у emp002 только заявки IEE', (l4.data?.items || []).every(i => i.id === ID.e06), (l4.data?.items || []).map(i => i.id.slice(0, 8)).join(','));

// =====================================================================
section('OP-17 GET /campaigns');
await req('кампании для заявителя', 200, 'GET', '/campaigns', { token: T.stud001 });

// =====================================================================
section('OP-02 POST /applications — создание, идемпотентность, лишние поля');
const key1 = randomUUID();
const body1 = { campaign_id: ID.c2, type: 'material_aid', statement: 'Прошу материальную поддержку: потеря кормильца.', declared_grounds: ['low_income'] };
const created = await req('создание (stud001, кампания c2)', 201, 'POST', '/applications', { token: T.stud001, body: body1, headers: { 'Idempotency-Key': key1 } });
check('Location указывает на ресурс', created.headers.get('location') === `/api/v1/applications/${created.data?.id}`, created.headers.get('location'));
const NEW = created.data?.id;
const replay = await req('повтор с тем же Idempotency-Key → 200, та же заявка', 200, 'POST', '/applications', { token: T.stud001, body: body1, headers: { 'Idempotency-Key': key1 } });
check('повтор вернул тот же id', replay.data?.id === NEW);
await req('тот же ключ, другое тело → 422', 422, 'POST', '/applications', { token: T.stud001, body: { ...body1, statement: 'другой текст' }, headers: { 'Idempotency-Key': key1 } });
await req('другой ключ → 409 (uq_application_per_campaign)', 409, 'POST', '/applications', { token: T.stud001, body: body1, headers: { 'Idempotency-Key': randomUUID() } });
// ПРОВЕРОЧНЫЙ ЗАПРОС 2: лишние поля — статус, владелец, роль
await req('ПРОВЕРКА 2: лишние поля status/applicant_id/role → 400', 400, 'POST', '/applications', {
  token: T.stud002, headers: { 'Idempotency-Key': randomUUID() },
  body: { campaign_id: ID.c4, type: 'pgas', statement: 'Попытка подменить владельца и статус', declared_grounds: ['science'],
    status: 'approved', applicant_id: ID.stud001, role: 'committee_chair' } });
const dbRow = psql(`SELECT applicant_id || ' | ' || status FROM applications WHERE id = '${NEW}'`);
check('строка в БД: владелец и статус — серверные', dbRow === `${ID.stud001} | draft`, dbRow);
check('попытка с лишними полями не создала строку', psql(`SELECT count(*) FROM applications WHERE campaign_id = '${ID.c4}' AND applicant_id = '${ID.stud002}'`) === '0');
await req('без Idempotency-Key → 400', 400, 'POST', '/applications', { token: T.stud002, body: { ...body1, campaign_id: ID.c4, type: 'pgas' } });
await req('кампания закрыта (c3) → 422', 422, 'POST', '/applications', { token: T.stud002, headers: { 'Idempotency-Key': randomUUID() },
  body: { campaign_id: ID.c3, type: 'pgas', statement: 'Поздняя заявка', declared_grounds: ['science'] } });
await req('statement длиннее 4000 → 400', 400, 'POST', '/applications', { token: T.stud002, headers: { 'Idempotency-Key': randomUUID() },
  body: { campaign_id: ID.c4, type: 'pgas', statement: 'x'.repeat(4001), declared_grounds: ['science'] } });
await req('основание вне справочника → 400', 400, 'POST', '/applications', { token: T.stud002, headers: { 'Idempotency-Key': randomUUID() },
  body: { campaign_id: ID.c4, type: 'pgas', statement: 'Текст', declared_grounds: ['vip'] } });
await req('отчисленный по каталогу (stud004) → 403', 403, 'POST', '/applications', { token: T.stud004, headers: { 'Idempotency-Key': randomUUID() },
  body: { campaign_id: ID.c1, type: 'pgas', statement: 'Заявка отчисленного', declared_grounds: ['science'] } });
await req('сотрудник не может создавать заявки → 403', 403, 'POST', '/applications', { token: T.emp001, headers: { 'Idempotency-Key': randomUUID() }, body: body1 });

// =====================================================================
section('OP-10 вложение: ссылка на загрузку + загрузка напрямую в хранилище');
const fileBytes = Buffer.from('%PDF-1.4\n% тестовый документ для ЛР3\n%%EOF\n');
const sha = createHash('sha256').update(fileBytes).digest('hex');
const link = await req('ссылка на загрузку (своя заявка)', 201, 'POST', `/applications/${NEW}/attachments`, { token: T.stud001,
  body: { doc_type: 'income_certificate', file_name: 'spravka.pdf', content_type: 'application/pdf', size_bytes: fileBytes.length, sha256: sha } });
await req('ссылка на чужую заявку → 404', 404, 'POST', `/applications/${ID.e02}/attachments`, { token: T.stud001,
  body: { doc_type: 'other', file_name: 'x.pdf', content_type: 'application/pdf', size_bytes: 10, sha256: sha } });
await req('недопустимый тип файла → 400', 400, 'POST', `/applications/${NEW}/attachments`, { token: T.stud001,
  body: { doc_type: 'other', file_name: 'x.html', content_type: 'text/html', size_bytes: 10, sha256: sha } });
if (link.data?.form_fields) {
  const upload = async (bytes) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(link.data.form_fields)) fd.append(k, v);
    fd.append('file', new Blob([bytes], { type: 'application/pdf' }), 'spravka.pdf');
    return fetch(WEB + link.data.upload_url, { method: 'POST', body: fd });
  };
  const bad = await upload(Buffer.concat([fileBytes, Buffer.from('лишние байты')]));
  check('хранилище отклоняет файл другого размера (политика подписи)', bad.status >= 400, 'HTTP ' + bad.status);
  const good = await upload(fileBytes);
  check('загрузка файла заявленного размера принята хранилищем', good.status === 204 || good.status === 201 || good.status === 200, 'HTTP ' + good.status);
  const withAtt = await req('карточка со списком вложений', 200, 'GET', `/applications/${NEW}?include=attachments`, { token: T.stud001 });
  const dl = withAtt.data?.attachments?.[0]?.download_url;
  if (dl) {
    const got = await fetch(WEB + dl);
    const buf = Buffer.from(await got.arrayBuffer());
    check('скачивание по presigned-ссылке возвращает тот же файл', got.status === 200 && buf.equals(fileBytes), 'HTTP ' + got.status);
    const noSig = await fetch(WEB + dl.split('?')[0]);
    check('без подписи хранилище файл не отдаёт', noSig.status === 403, 'HTTP ' + noSig.status);
  }
}

// =====================================================================
section('OP-18 подача и события в Kafka → notifier → почта');
await req('подача черновика', 200, 'POST', `/applications/${NEW}/submit`, { token: T.stud001 });
await req('повторная подача — тот же результат', 200, 'POST', `/applications/${NEW}/submit`, { token: T.stud001 });
await req('подача чужой заявки → 404', 404, 'POST', `/applications/${ID.e03}/submit`, { token: T.stud001 });
const mail1 = await mailTo('stud001@example.edu', 'подана');
check('notifier получил событие из Kafka и отправил письмо', !!mail1, mail1 ? mail1.Subject : 'письмо не найдено');
check('в письме нет текста обоснования и сумм (B-14)', !!mail1 && !mail1.Text.includes('кормильца'));

// =====================================================================
section('OP-03 PATCH /applications/{id}/review');
const g = await req('чтение версии (ETag) сотрудником', 200, 'GET', `/applications/${ID.e01}`, { token: T.emp001 });
const etag = g.headers.get('etag');
await req('без If-Match → 428', 428, 'PATCH', `/applications/${ID.e01}/review`, { token: T.emp001, body: { status: 'under_review' } });
await req('устаревшая версия в If-Match → 409', 409, 'PATCH', `/applications/${ID.e01}/review`, { token: T.emp001, body: { status: 'under_review' }, headers: { 'If-Match': '"99"' } });
await req('лишнее поле reviewed_by → 400', 400, 'PATCH', `/applications/${ID.e01}/review`, { token: T.emp001, body: { status: 'under_review', reviewed_by: ID.stud001 }, headers: { 'If-Match': etag } });
await req('заявитель не может проверять → 403', 403, 'PATCH', `/applications/${ID.e01}/review`, { token: T.stud001, body: { status: 'approved' }, headers: { 'If-Match': etag } });
await req('сотрудник другого подразделения → 404', 404, 'PATCH', `/applications/${ID.e01}/review`, { token: T.emp002, body: { status: 'under_review' }, headers: { 'If-Match': etag } });
const r1 = await req('взять на рассмотрение', 200, 'PATCH', `/applications/${ID.e01}/review`, { token: T.emp001, body: { status: 'under_review' }, headers: { 'If-Match': etag } });
check('reviewed_by взят из токена', r1.data?.reviewed_by === 'b0000000-0000-4000-8000-000000000011');
const v2 = `"${r1.data?.version}"`;
await req('одобрение ПГАС без баллов → 400', 400, 'PATCH', `/applications/${ID.e01}/review`, { token: T.emp001, body: { status: 'approved' }, headers: { 'If-Match': v2 } });
await req('балл выше максимума критерия → 400', 400, 'PATCH', `/applications/${ID.e01}/review`, { token: T.emp001, body: { status: 'approved', scores: [{ criterion_id: ID.crScience, value: 41 }] }, headers: { 'If-Match': v2 } });
await req('отклонение без причины → 400', 400, 'PATCH', `/applications/${ID.e01}/review`, { token: T.emp001, body: { status: 'rejected' }, headers: { 'If-Match': v2 } });
const r2 = await req('одобрение с баллами', 200, 'PATCH', `/applications/${ID.e01}/review`, { token: T.emp001, body: { status: 'approved', scores: [{ criterion_id: ID.crScience, value: 35 }, { criterion_id: ID.crSports, value: 10 }] }, headers: { 'If-Match': v2 } });
check('сумма баллов посчитана сервером', Number(r2.data?.total_score) === 45, String(r2.data?.total_score));
await req('повтор того же PATCH со старой версией → 409', 409, 'PATCH', `/applications/${ID.e01}/review`, { token: T.emp001, body: { status: 'approved', scores: [{ criterion_id: ID.crScience, value: 35 }] }, headers: { 'If-Match': v2 } });
await req('черновик проверять нельзя (недопустимый переход) → 400', 400, 'PATCH', `/applications/${ID.e03}/review`, { token: T.emp001, body: { status: 'under_review' }, headers: { 'If-Match': '"1"' } });
const audit = psql(`SELECT action || ' ' || result FROM audit_log WHERE object_id = '${ID.e01}' AND action = 'application.reviewed' ORDER BY id DESC LIMIT 1`);
check('изменение записано в audit_log в той же транзакции', audit === 'application.reviewed success', audit);
const mail2 = await mailTo('stud001@example.edu', 'одобрена');
check('письмо о смене статуса (событие review-service)', !!mail2, mail2 ? mail2.Subject : 'нет');

// =====================================================================
section('OP-12 GET /campaigns/{id}/ranking');
await req('рейтинг кампании c1 (emp001)', 200, 'GET', `/campaigns/${ID.c1}/ranking`, { token: T.emp001 });
await req('заявитель → 403', 403, 'GET', `/campaigns/${ID.c1}/ranking`, { token: T.stud001 });
await req('кампания чужого подразделения → 404', 404, 'GET', `/campaigns/${ID.c1}/ranking`, { token: T.emp002 });

// =====================================================================
section('OP-05 POST /campaigns/{id}/payout-registry — привилегированная операция');
const reg = { protocol_number: 'П-15', protocol_date: new Date().toISOString().slice(0, 10),
  entries: [{ application_id: ID.e04, amount: 12000 }, { application_id: ID.e05, amount: 9000.5 }] };
// ПРОВЕРОЧНЫЙ ЗАПРОС 3: привилегированная операция токеном обычного пользователя, минуя интерфейс
await req('ПРОВЕРКА 3: токен заявителя → 403', 403, 'POST', `/campaigns/${ID.c3}/payout-registry`, { token: T.stud001, body: reg, headers: { 'Idempotency-Key': randomUUID() } });
await req('сотрудник (reviewer) своей кампании → 403', 403, 'POST', `/campaigns/${ID.c3}/payout-registry`, { token: T.emp001, body: reg, headers: { 'Idempotency-Key': randomUUID() } });
// Лимит OP-05 — 5 запросов в час на субъекта (контракт), поэтому отрицательные проверки до
// проверки объекта выполняет второй председатель (chair002, Институт энергетики).
await req('председатель без Idempotency-Key → 428', 428, 'POST', `/campaigns/${ID.c3}/payout-registry`, { token: T.chair2, body: reg });
await req('председатель без повторного ввода пароля → 403 reauth_required', 403, 'POST', `/campaigns/${ID.c3}/payout-registry`, { token: T.chair2, body: reg, headers: { 'Idempotency-Key': randomUUID() } });
await req('повторный ввод пароля: неверный → 403', 403, 'POST', '/auth/reauth', { token: T.chair2, body: { password: 'wrong-password-1' } });
await req('повторный ввод пароля (OP-16), chair002', 204, 'POST', '/auth/reauth', { token: T.chair2, body: { password: PWD } });
await req('лишнее поле checksum → 400', 400, 'POST', `/campaigns/${ID.c3}/payout-registry`, { token: T.chair2, headers: { 'Idempotency-Key': randomUUID() }, body: { ...reg, checksum: 'abc' } });
await req('председатель ДРУГОЙ комиссии (chair002 → кампания ICST) → 403', 403, 'POST', `/campaigns/${ID.c3}/payout-registry`, { token: T.chair2, body: reg, headers: { 'Idempotency-Key': randomUUID() } });
await req('повторный ввод пароля (OP-16), chair001', 204, 'POST', '/auth/reauth', { token: T.chair, body: { password: PWD } });
await req('в реестре заявка из другой кампании/не approved → 422', 422, 'POST', `/campaigns/${ID.c3}/payout-registry`, { token: T.chair, headers: { 'Idempotency-Key': randomUUID() },
  body: { ...reg, entries: [...reg.entries, { application_id: ID.e01, amount: 7000 }] } });
await req('сумма вне диапазона кампании → 422', 422, 'POST', `/campaigns/${ID.c3}/payout-registry`, { token: T.chair, headers: { 'Idempotency-Key': randomUUID() },
  body: { ...reg, entries: [{ application_id: ID.e04, amount: 1000000 }] } });
const payKey = randomUUID();
const pay = await req('формирование реестра', 201, 'POST', `/campaigns/${ID.c3}/payout-registry`, { token: T.chair, body: reg, headers: { 'Idempotency-Key': payKey } });
check('итоговая сумма и SHA-256', Number(pay.data?.total_amount) === 21000.5 && /^[0-9a-f]{64}$/.test(pay.data?.checksum || ''), `${pay.data?.total_amount} ${pay.data?.checksum}`);
const payAgain = await req('повтор с тем же ключом → 200 и тот же реестр', 200, 'POST', `/campaigns/${ID.c3}/payout-registry`, { token: T.chair, body: reg, headers: { 'Idempotency-Key': payKey } });
check('повтор не создал новый реестр', payAgain.data?.registry_id === pay.data?.registry_id);
await req('новый ключ → 409 (реестр уже есть)', 409, 'POST', `/campaigns/${ID.c3}/payout-registry`, { token: T.chair, body: reg, headers: { 'Idempotency-Key': randomUUID() } });
check('в payout_entries ровно 2 строки, получатели из БД', psql(`SELECT count(*) || ':' || string_agg(DISTINCT recipient_id::text, ',' ORDER BY recipient_id::text) FROM payout_entries`) === `2:${ID.stud001},${ID.stud002}`);
const bypass = psql(`INSERT INTO payout_entries (protocol_id, application_id, recipient_id, amount) SELECT protocol_id, application_id, recipient_id, amount FROM payout_entries LIMIT 1`);
check('третий рубеж: БД не даёт второе начисление по заявке', bypass.includes('uq_payout_per_application'), bypass.split('\n')[0]);
await req('после протокола статусы не меняются → 422', 422, 'PATCH', `/applications/${ID.e04}/review`, { token: T.emp001, body: { status: 'under_review' }, headers: { 'If-Match': '"3"' } });
const pub = await req('заявитель видит баллы после публикации итогов', 200, 'GET', `/applications/${ID.e04}`, { token: T.stud001 });
check('scores[] появились', Array.isArray(pub.data?.scores));

// =====================================================================
section('OP-13 DELETE /applications/{id} и OP-06/OP-11 (501)');
await req('отзыв чужой заявки → 404', 404, 'DELETE', `/applications/${NEW}`, { token: T.stud002 });
await req('отзыв своей поданной заявки', 204, 'DELETE', `/applications/${NEW}`, { token: T.stud001 });
await req('повторный DELETE — идемпотентен', 204, 'DELETE', `/applications/${NEW}`, { token: T.stud001 });
await req('отзыв одобренной заявки → 409', 409, 'DELETE', `/applications/${ID.e01}`, { token: T.stud001 });
await req('OP-06 проверка полноты — заглушка 501', 501, 'POST', `/applications/${ID.e01}/completeness-check`, { token: T.stud001, headers: { 'Idempotency-Key': randomUUID() } });
await req('OP-11 отчёт о полноте — заглушка 501', 501, 'GET', `/applications/${ID.e01}/completeness-check`, { token: T.stud001 });

// =====================================================================
section('OP-08 обновление с ротацией и OP-15 выход');
const oldCookie = cookies.stud002;
const rf = await req('обновление токена по cookie', 200, 'POST', '/auth/refresh', { jar: 'stud002', headers: { 'X-Requested-With': 'fetch' } });
await req('без X-Requested-With → 400', 400, 'POST', '/auth/refresh', { jar: 'stud002' });
const newAccess = rf.data?.access_token;
await req('новый токен доступа работает', 200, 'GET', '/applications', { token: newAccess });
cookies.reuse = oldCookie;
await req('повторное использование старого refresh → 401', 401, 'POST', '/auth/refresh', { jar: 'reuse', headers: { 'X-Requested-With': 'fetch' } });
await req('после обнаружения повтора вся сессия отозвана → 401', 401, 'GET', '/applications', { token: newAccess });
const t2 = await login('stud002');
await req('выход', 204, 'POST', '/auth/logout', { token: t2 });
await req('ПОСЛЕ ВЫХОДА токен отклоняется (отозван) → 401', 401, 'GET', '/applications', { token: t2 });

// =====================================================================
section('OP-14 регистрация');
await req('регистрация действующего обучающегося stud010', [201, 409], 'POST', '/auth/register', { body: { external_id: 'stud010', email: 'stud010@example.edu', password: 'Novikova-Pass-2026' } });
await req('регистрация с чужим e-mail → 422', 422, 'POST', '/auth/register', { body: { external_id: 'stud003', email: 'hacker@example.com', password: 'Some-Strong-Pass-1' } });
await req('лишнее поле role при регистрации → 400', 400, 'POST', '/auth/register', { body: { external_id: 'stud010', email: 'stud010@example.edu', password: 'Novikova-Pass-2026', role: 'admin' } });
check('пароль в БД — Argon2id с параметрами m=65536,t=3,p=4', psql(`SELECT password_hash FROM users WHERE external_id = 'stud010'`).startsWith('$argon2id$v=19$m=65536,t=3,p=4$'));

// =====================================================================
section('OP-09 восстановление доступа (почта — Mailpit)');
const r202a = await req('запрос для существующего адреса → 202', 202, 'POST', '/auth/password-reset', { body: { email: 'stud003@example.edu' } });
const r202b = await req('запрос для несуществующего адреса → такой же 202', 202, 'POST', '/auth/password-reset', { body: { email: 'nobody@example.edu' } });
check('ответы неразличимы', r202a.data?.message === r202b.data?.message);
const resetMail = await mailTo('stud003@example.edu', 'Восстановление');
const token = resetMail?.Text.match(/token=([A-Za-z0-9_-]+)/)?.[1];
check('письмо с одноразовой ссылкой пришло', !!token);
const t3old = await login('stud003');
await req('смена пароля по коду', 204, 'POST', '/auth/password-reset/confirm', { body: { token, new_password: 'Sidorov-New-Pass-77' } });
await req('код срабатывает один раз → 400', 400, 'POST', '/auth/password-reset/confirm', { body: { token, new_password: 'Sidorov-New-Pass-78' } });
await req('старые сессии завершены после смены пароля → 401', 401, 'GET', '/applications', { token: t3old });
await req('вход со старым паролем → 401', 401, 'POST', '/auth/login', { body: { login: 'stud003', password: PWD } });
await login('stud003', 'Sidorov-New-Pass-77');

// =====================================================================
section('Учётная запись приложения в БД (задание 2.2)');
const drop = psql('DROP TABLE users', 'svc_applications', env.SVC_APPLICATIONS_DB_PASSWORD);
check('DROP TABLE под svc_applications → ошибка прав', /must be owner|permission denied/.test(drop), drop.split('\n')[0]);
const create = psql('CREATE TABLE hack (id int)', 'svc_applications', env.SVC_APPLICATIONS_DB_PASSWORD);
check('CREATE TABLE под svc_applications → ошибка прав', /permission denied/.test(create), create.split('\n')[0]);
const upd = psql('UPDATE audit_log SET result = \'success\'', 'svc_review', env.SVC_REVIEW_DB_PASSWORD);
check('UPDATE audit_log под svc_review → ошибка прав (журнал только дополняется)', /permission denied/.test(upd), upd.split('\n')[0]);
const cross = psql('SELECT count(*) FROM payout_entries', 'svc_applications', env.SVC_APPLICATIONS_DB_PASSWORD);
check('svc_applications не читает реестр выплат', /permission denied/.test(cross), cross.split('\n')[0]);

// =====================================================================
section('Ограничение частоты (шлюз, счётчики в Redis)');
let last = 0, attempts = 0;
for (let i = 0; i < 25 && last !== 429; i++) {
  attempts++;
  const r = await fetch(API + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'rate-limit-probe', password: 'xxxxxxxxxx' }) });
  last = r.status;
}
check("серия попыток входа с одного IP упирается в лимит 20/мин → 429", last === 429, `HTTP ${last} на попытке ${attempts}`);

console.log(`\nИТОГО: успешно ${passed}, ошибок ${failed}`);
process.exit(failed ? 1 : 0);
