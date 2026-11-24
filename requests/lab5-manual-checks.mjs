#!/usr/bin/env node
// =====================================================================
//  ЛР № 5, задание 3.4–3.5: ручные проверки защищённости на живой системе.
//  Каждая проверка описывает БЕЗОПАСНОЕ поведение; строка [FAIL] — находка.
//  Запуск из корня репозитория на чистых тестовых данных:
//      docker compose down -v && docker compose up -d
//      NODE_EXTRA_CA_CERTS=secrets/gateway.crt node requests/lab5-manual-checks.mjs
//  Сканировать разрешено только собственную локальную систему: адреса — только localhost.
// =====================================================================
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createSign, createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)
  .filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
if (!process.env.NODE_EXTRA_CA_CERTS) {
  console.error('Запуск: NODE_EXTRA_CA_CERTS=secrets/gateway.crt node requests/lab5-manual-checks.mjs');
  process.exit(2);
}
const PWD = env.DEMO_USERS_PASSWORD;
const ID = {
  stud001: 'b0000000-0000-4000-8000-000000000001', stud002: 'b0000000-0000-4000-8000-000000000002',
  c1: 'c0000000-0000-4000-8000-000000000001', c2: 'c0000000-0000-4000-8000-000000000002',
  c3: 'c0000000-0000-4000-8000-000000000003', c4: 'c0000000-0000-4000-8000-000000000004',
  e01: 'e0000000-0000-4000-8000-000000000001', e02: 'e0000000-0000-4000-8000-000000000002',
  e03: 'e0000000-0000-4000-8000-000000000003', e04: 'e0000000-0000-4000-8000-000000000004',
  e05: 'e0000000-0000-4000-8000-000000000005',
};

let passed = 0; const failed = [];
function section(t) { console.log('\n=== ' + t); }
function check(id, name, cond, info = '') {
  if (cond) passed++; else failed.push(`${id} ${name}`);
  console.log(`${cond ? '[OK]  ' : '[FAIL]'} ${id} ${name}${info ? '\n        ← ' + info : ''}`);
}

/** Сырой HTTP(S)-запрос: путь уходит как есть (без нормализации «..», в отличие от fetch). */
function raw(method, url, { headers = {}, body, token } = {}) {
  const u = new URL(url);
  const h = { ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  let data;
  if (body !== undefined) { data = typeof body === 'string' ? body : JSON.stringify(body); h['Content-Type'] ??= 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
  const rawPath = url.slice(url.indexOf('/', url.indexOf('//') + 2));
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const r = lib.request({ host: u.hostname, port: u.port, method, path: rawPath, headers: h }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* не JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const GW = 'https://localhost:8443';
const API = GW + '/api/v1';
const WEB = 'http://localhost:8080';
const STAFF = 'http://127.0.0.1:8081';
const api = (m, p, o) => raw(m, API + p, o);
const short = r => (r.text || '').replace(/\s+/g, ' ').slice(0, 170);

function psql(sql) {
  try {
    return execFileSync('docker', ['compose', 'exec', '-T', '-e', `PGPASSWORD=${env.POSTGRES_PASSWORD}`, 'postgres',
      'psql', '-h', 'localhost', '-U', 'postgres', '-d', 'scholarship', '-At', '-c', sql],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) { return 'ERROR: ' + (e.stderr || e.message).trim(); }
}

async function login(name, password = PWD) {
  const r = await api('POST', '/auth/login', { body: { login: name, password } });
  if (r.status !== 200) throw new Error(`вход ${name}: ${r.status} ${short(r)}`);
  return { token: r.json.access_token, cookie: r.headers['set-cookie']?.[0] };
}

const b64u = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function jwt({ header = { alg: 'RS256', typ: 'at+jwt', kid: 'auth-1' }, claims = {}, key, hmacSecret, sig } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: 'scholarship-auth', aud: 'scholarship-api', sub: ID.stud001, sid: 'forged', jti: randomUUID(),
    roles: ['applicant'], iat: now - 60, nbf: now - 60, exp: now + 600, ...claims };
  const input = `${b64u(header)}.${b64u(payload)}`;
  if (sig !== undefined) return `${input}.${sig}`;
  if (hmacSecret) return `${input}.${createHmac('sha256', hmacSecret).update(input).digest('base64url')}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(key).toString('base64url')}`;
}
const realKey = Buffer.from(env.JWT_PRIVATE_KEY_B64, 'base64').toString('utf8');
const publicPem = Buffer.from(env.JWT_PUBLIC_KEY_B64, 'base64').toString('utf8');
const { privateKey: attackerKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

// =====================================================================
const S = {
  stud001: await login('stud001'), stud002: await login('stud002'), emp001: await login('emp001'),
  emp002: await login('emp002'), chair: await login('chair001'), sup: await login('sup001'),
};
const T = Object.fromEntries(Object.entries(S).map(([k, v]) => [k, v.token]));

section('A. Три проверочных запроса (ЛР № 2, ЛР № 3)');
{
  const foreign = await api('GET', `/applications/${ID.e02}`, { token: T.stud001 });
  const missing = await api('GET', `/applications/${randomUUID()}`, { token: T.stud001 });
  check('A1', 'объект другого пользователя с действительным токеном → 404, как несуществующий', foreign.status === 404 && foreign.json?.message === missing.json?.message, `${foreign.status} ${short(foreign)}`);
  const extra = await api('POST', '/applications', { token: T.stud002, headers: { 'Idempotency-Key': randomUUID() },
    body: { campaign_id: ID.c4, type: 'pgas', statement: 'Попытка подменить владельца и статус', declared_grounds: ['science'], status: 'approved', applicant_id: ID.stud001, role: 'committee_chair' } });
  check('A2', 'лишние поля status/applicant_id/role → 400, строка не создана', extra.status === 400 &&
    psql(`SELECT count(*) FROM applications WHERE campaign_id='${ID.c4}' AND applicant_id='${ID.stud002}'`) === '0', `${extra.status} ${short(extra)}`);
  const priv = await api('POST', `/campaigns/${ID.c3}/payout-registry`, { token: T.stud001, headers: { 'Idempotency-Key': randomUUID() },
    body: { protocol_number: 'П-1', protocol_date: '2026-11-01', entries: [{ application_id: ID.e04, amount: 12000 }] } });
  check('A3', 'привилегированная операция (реестр выплат) токеном заявителя → 403', priv.status === 403, `${priv.status} ${short(priv)}`);
}

section('B. Подделанный и просроченный токен');
{
  const url = `/applications/${ID.e01}`;
  const cases = [
    ['B1', 'подпись чужим ключом RSA (верные iss/aud/exp)', jwt({ key: attackerKey })],
    ['B2', 'alg=none', jwt({ header: { alg: 'none', typ: 'at+jwt' }, sig: '' })],
    ['B3', 'подмена алгоритма: HS256 с открытым ключом как секретом', jwt({ header: { alg: 'HS256', typ: 'at+jwt' }, hmacSecret: publicPem })],
    ['B4', 'изменённая роль в полезной нагрузке с прежней подписью', (() => { const [h, p, s] = T.stud001.split('.'); const c = JSON.parse(Buffer.from(p, 'base64url')); c.roles = ['committee_chair']; return `${h}.${b64u(c)}.${s}`; })()],
    ['B5', 'просроченный токен с верной подписью (exp −1 ч)', jwt({ key: realKey, claims: { exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200, nbf: Math.floor(Date.now() / 1000) - 7200 } })],
    ['B6', 'верная подпись, но несуществующая сессия sid (отозван/подделан)', jwt({ key: realKey })],
    ['B7', 'refresh-токен вместо токена доступа', (S.stud001.cookie || '').split(';')[0].split('=')[1] || 'x'],
  ];
  for (const [id, name, tok] of cases) {
    const r = await api('GET', url, { token: tok });
    check(id, name + ' → 401', r.status === 401, `${r.status} ${short(r)}`);
  }
  const t = await login('stud001');
  await api('POST', '/auth/logout', { token: t.token });
  const after = await api('GET', url, { token: t.token });
  check('B8', 'токен после выхода (сессия удалена) → 401', after.status === 401, `${after.status}`);
}

section('C. Повторная отправка неидемпотентных операций');
{
  const key = randomUUID();
  const body = { campaign_id: ID.c2, type: 'material_aid', statement: 'Повторная отправка: проверка идемпотентности', declared_grounds: ['low_income'] };
  const [r1, r2] = await Promise.all([
    api('POST', '/applications', { token: T.stud001, headers: { 'Idempotency-Key': key }, body }),
    api('POST', '/applications', { token: T.stud001, headers: { 'Idempotency-Key': key }, body }),
  ]);
  const ids = new Set([r1.json?.id, r2.json?.id]);
  check('C1', 'два одновременных POST /applications с одним Idempotency-Key → одна заявка', ids.size === 1 && [r1.status, r2.status].sort().join() === '200,201',
    `${r1.status}/${r2.status} ids=${[...ids].join(',')}`);
  const r3 = await api('POST', '/applications', { token: T.stud001, headers: { 'Idempotency-Key': randomUUID() }, body });
  check('C2', 'тот же запрос с новым ключом → 409 (ограничение БД)', r3.status === 409, `${r3.status} ${short(r3)}`);
  const r4 = await api('POST', '/applications', { token: T.stud001, body });
  check('C3', 'без Idempotency-Key → 400', r4.status === 400, `${r4.status}`);
  check('C4', 'в БД одна заявка stud001 в кампании c2', psql(`SELECT count(*) FROM applications WHERE campaign_id='${ID.c2}' AND applicant_id='${ID.stud001}'`) === '1');

  const g = await api('GET', `/applications/${ID.e01}`, { token: T.emp001 });
  const patch = () => api('PATCH', `/applications/${ID.e01}/review`, { token: T.emp001, headers: { 'If-Match': g.headers.etag }, body: { status: 'under_review' } });
  const [p1, p2] = await Promise.all([patch(), patch()]);
  check('C5', 'два одновременных PATCH с одной версией (If-Match) → 200 и 409', [p1.status, p2.status].sort().join() === '200,409', `${p1.status}/${p2.status}`);

  await api('POST', '/auth/reauth', { token: T.chair, body: { password: PWD } });
  const regKey = randomUUID();
  const reg = { protocol_number: 'П-77', protocol_date: new Date().toISOString().slice(0, 10), entries: [{ application_id: ID.e04, amount: 12000 }, { application_id: ID.e05, amount: 9000 }] };
  const [x1, x2] = await Promise.all([
    api('POST', `/campaigns/${ID.c3}/payout-registry`, { token: T.chair, headers: { 'Idempotency-Key': regKey }, body: reg }),
    api('POST', `/campaigns/${ID.c3}/payout-registry`, { token: T.chair, headers: { 'Idempotency-Key': regKey }, body: reg }),
  ]);
  const x3 = await api('POST', `/campaigns/${ID.c3}/payout-registry`, { token: T.chair, headers: { 'Idempotency-Key': randomUUID() }, body: reg });
  check('C6', 'реестр выплат: повтор с тем же ключом → тот же реестр, с новым → 409', [x1.status, x2.status].sort().join() === '200,201' && x1.json?.registry_id === x2.json?.registry_id && x3.status === 409,
    `${x1.status}/${x2.status}/${x3.status}`);
  check('C7', 'в payout_entries ровно 2 строки (нет двойного начисления)', psql('SELECT count(*) FROM payout_entries') === '2');
}

section('D. Заголовки безопасности, CORS, cookie');
{
  const r = await api('GET', '/campaigns', { token: T.stud001 });
  const h = r.headers;
  check('D1', 'шлюз: HSTS, nosniff, X-Frame-Options DENY, Cache-Control no-store', !!h['strict-transport-security'] && h['x-content-type-options'] === 'nosniff' && h['x-frame-options'] === 'DENY' && /no-store/.test(h['cache-control'] || ''),
    JSON.stringify({ hsts: h['strict-transport-security'], xcto: h['x-content-type-options'], xfo: h['x-frame-options'], cc: h['cache-control'] }));
  check('D2', 'шлюз: Content-Security-Policy для ответов API', !!h['content-security-policy'], `CSP=${h['content-security-policy']}`);
  check('D3', 'шлюз не раскрывает Server/X-Powered-By', !h.server && !h['x-powered-by'], `server=${h.server}`);
  const pre = await raw('OPTIONS', API + '/applications', { headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
  const cors = await api('GET', '/campaigns', { token: T.stud001, headers: { Origin: 'https://evil.example' } });
  check('D4', 'CORS: чужой Origin не получает Access-Control-Allow-Origin', !pre.headers['access-control-allow-origin'] && !cors.headers['access-control-allow-origin'],
    `preflight=${pre.status} ACAO=${pre.headers['access-control-allow-origin'] ?? '—'}/${cors.headers['access-control-allow-origin'] ?? '—'}`);
  const ck = S.stud002.cookie || '';
  check('D5', 'cookie refresh_token: HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth', /HttpOnly/i.test(ck) && /Secure/i.test(ck) && /SameSite=Strict/i.test(ck) && /Path=\/api\/v1\/auth/i.test(ck), ck.replace(/refresh_token=[^;]+/, 'refresh_token=…'));
  for (const [id, base] of [['D6', WEB], ['D7', STAFF]]) {
    const w = await raw('GET', base + '/');
    const wh = w.headers;
    check(id, `${base}: CSP, nosniff, XFO, Referrer-Policy, без версии nginx`, !!wh['content-security-policy'] && wh['x-content-type-options'] === 'nosniff' && wh['x-frame-options'] === 'DENY' && !!wh['referrer-policy'] && !/\d/.test(wh.server || ''),
      `server=${wh.server} csp=${(wh['content-security-policy'] || '').slice(0, 40)}…`);
  }
  // ответ хранилища вложений через nginx: заголовки server-блока не должны теряться (add_header в location)
  const att = await raw('GET', WEB + '/applications-attachments/applications/x?X-Amz-Signature=0');
  check('D8', 'ответ /applications-attachments/: Referrer-Policy, X-Frame-Options, Cache-Control no-store', !!att.headers['referrer-policy'] && !!att.headers['x-frame-options'] && /no-store/.test(att.headers['cache-control'] || ''),
    JSON.stringify({ status: att.status, rp: att.headers['referrer-policy'], xfo: att.headers['x-frame-options'], cc: att.headers['cache-control'] }));
}

section('E. Раскрытие информации в ошибках');
{
  const leak = r => /Exception|at [a-z]+\.[a-z]+\.|org\.springframework|java\.|SQL|postgres|stack/i.test(r.text);
  const cases = [
    ['E1', 'битый JSON', () => api('POST', '/auth/login', { body: '{"login":' })],
    ['E2', 'неверный тип поля', () => api('POST', '/applications', { token: T.stud001, headers: { 'Idempotency-Key': randomUUID() }, body: { campaign_id: 1, type: [], statement: {}, declared_grounds: 'x' } })],
    ['E3', 'неподдерживаемый метод', () => api('PUT', `/applications/${ID.e01}`, { token: T.stud001, body: {} })],
    ['E4', 'неподдерживаемый Content-Type', () => api('POST', '/auth/login', { body: 'login=a', headers: { 'Content-Type': 'text/plain' } })],
    ['E5', 'тело больше лимита (64 КБ)', () => api('POST', '/auth/login', { body: { login: 'x'.repeat(70000), password: 'y' } })],
    ['E6', 'несуществующий путь', () => api('GET', '/no-such-endpoint', { token: T.stud001 })],
    ['E7', 'некорректный UUID в пути', () => api('GET', '/applications/%27%20OR%201=1--', { token: T.stud001 })],
  ];
  for (const [id, name, f] of cases) {
    const r = await f();
    check(id, `${name} → ${r.status}, без стека/SQL/версий`, r.status >= 400 && r.status < 500 && !leak(r), `${r.status} ${short(r)}`);
  }
}

section('F. Инъекции');
{
  const sqli = await api('GET', `/applications?sort=${encodeURIComponent("created_at;SELECT pg_sleep(5)")}`, { token: T.emp001 });
  check('F1', 'SQL в sort → 400 (белый список)', sqli.status === 400, `${sqli.status}`);
  const t0 = Date.now();
  const sqli2 = await api('GET', `/applications?status=${encodeURIComponent("submitted' AND pg_sleep(5)--")}`, { token: T.emp001 });
  check('F2', 'SQL в status → 400 без задержки', sqli2.status === 400 && Date.now() - t0 < 3000, `${sqli2.status} ${Date.now() - t0} мс`);
  const cur = await api('GET', `/applications?cursor=${Buffer.from("-created_at|2026-01-01T00:00:00Z' OR '1'='1|x").toString('base64url')}`, { token: T.emp001 });
  check('F3', 'подделанный курсор → 400', cur.status === 400, `${cur.status}`);
  const ldap = await api('POST', '/auth/register', { body: { external_id: '*)(uid=*', email: 'a@b.c', password: 'Ldap-Injection-1' } });
  check('F4', 'LDAP-фильтр в external_id → 400', ldap.status === 400, `${ldap.status} ${short(ldap)}`);
  const xss = await api('POST', '/applications', { token: T.stud002, headers: { 'Idempotency-Key': randomUUID() },
    body: { campaign_id: ID.c4, type: 'pgas', statement: 'x', declared_grounds: ['<script>alert(1)</script>'] } });
  check('F5', 'HTML в значении перечисления не отражается как разметка (JSON, nosniff)', xss.status === 400 && /application\/json/.test(xss.headers['content-type'] || ''), `${xss.status} ${xss.headers['content-type']}`);
}

section('G. Обход маршрутизации и внутренние эндпоинты');
{
  const p1 = await raw('GET', `${API}/auth/../../internal/users/${ID.stud001}/contact`);
  check('G1', 'шлюз: /api/v1/auth/../../internal/... не отдаёт контакт пользователя', p1.status >= 400 && !/@/.test(p1.text), `${p1.status} ${short(p1)}`);
  const p2 = await raw('GET', `${API}/auth/login/..;/..;/applications/${ID.e01}`);
  check('G2', 'шлюз: «..;» в пути не обходит проверку токена', p2.status === 401 || p2.status === 404 || p2.status === 400, `${p2.status}`);
  const p3 = await raw('GET', `${GW}/actuator/health`);
  check('G3', 'actuator сервисов через шлюз недоступен', p3.status === 404 || p3.status === 401, `${p3.status}`);
  const p4 = await raw('GET', `${API}/auth/login/../../applications/${ID.e02}`, { token: T.stud001 });
  check('G4', 'обход через «..» не даёт чужую заявку', p4.status !== 200, `${p4.status}`);
}

section('H. Ограничение частоты на входе и при повторном вводе пароля');
{
  let st = 0, n = 0, retry;
  for (; n < 25 && st !== 429; n++) {
    const r = await api('POST', '/auth/login', { body: { login: 'rate-limit-probe', password: 'xxxxxxxxxx' } });
    st = r.status; retry = r.headers['retry-after'];
  }
  check('H1', 'вход: серия попыток с одного IP → 429 и Retry-After (лимит 20/мин)', st === 429 && !!retry, `HTTP ${st} на попытке ${n}, Retry-After=${retry}`);
  // OP-16 подтверждает пароль по украденному токену доступа: без отдельного лимита это перебор пароля
  const t = (await (async () => { await new Promise(r => setTimeout(r, 61000)); return login('stud002'); })()).token;
  let rst = 0, m = 0;
  for (; m < 30 && rst !== 429; m++) {
    const r = await api('POST', '/auth/reauth', { token: t, body: { password: 'guess-' + m + '-xxxx' } });
    rst = r.status;
  }
  check('H2', 'OP-16 reauth: перебор пароля по токену доступа упирается в лимит (≤ 5 попыток)', rst === 429 && m <= 6, `HTTP ${rst} на попытке ${m}`);
}

section('I. Права на объект и свойства (ручной разбор карты кода)');
{
  const sup = await api('GET', `/applications/${ID.e01}`, { token: T.sup });
  check('I1', 'служба поддержки (R-07) видит только статус — без текста заявки и оснований', sup.status === 200 && !('statement' in (sup.json || {})) && !('declared_grounds' in (sup.json || {})),
    `поля: ${Object.keys(sup.json || {}).join(',')}`);
  const draft = await api('GET', `/applications/${ID.e03}`, { token: T.emp001 });
  check('I2', 'сотрудник не видит неподанный черновик заявителя (e03, draft) → 404', draft.status === 404, `${draft.status} ${short(draft)}`);
  const list = await api('GET', '/applications?status=draft', { token: T.emp001 });
  check('I3', 'в списке сотрудника нет черновиков', list.status === 200 && (list.json?.items || []).length === 0, `${list.status} items=${(list.json?.items || []).length}`);
  const rev = await api('PATCH', `/applications/${ID.e03}/review`, { token: T.emp001, headers: { 'If-Match': '"1"' }, body: { status: 'under_review' } });
  check('I4', 'OP-03 по черновику → 404 (как несуществующая), а не 400 с подтверждением существования', rev.status === 404, `${rev.status} ${short(rev)}`);
  const cc = await api('POST', `/applications/${ID.e02}/completeness-check`, { token: T.stud001 });
  check('I5', 'OP-06 по чужой заявке → 404 (проверка владельца до ответа)', cc.status === 404, `${cc.status} ${short(cc)}`);
}

section('J. Служебные веб-интерфейсы на 127.0.0.1');
{
  const ku = await raw('GET', 'http://localhost:8090/api/clusters');
  check('J1', 'Kafka UI требует входа (в топике auth.password-reset лежат коды восстановления)', ku.status === 401 || ku.status === 302 || ku.status === 403, `${ku.status} ${short(ku)}`);
  const mp = await raw('GET', 'http://localhost:8025/api/v1/messages?limit=1');
  check('J2', 'Mailpit (письма со ссылками восстановления) требует входа', mp.status === 401, `${mp.status}`);
}

console.log(`\nИТОГО: успешно ${passed}, находок ${failed.length}`);
failed.forEach(f => console.log('  - ' + f));
process.exit(0);
