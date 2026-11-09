// Клиент API (общий для веб-кабинета и панели сотрудника).
// Политика токенов: токен доступа хранится ТОЛЬКО в памяти (переменная модуля) —
// не в localStorage/sessionStorage, откуда его прочитал бы любой внедрённый скрипт.
// Токен обновления лежит в cookie HttpOnly, JavaScript его не видит; после перезагрузки
// страницы сессия восстанавливается вызовом /auth/refresh.
'use strict';

const Api = (() => {
  let accessToken = null;
  let user = null;
  let refreshing = null;

  class ApiError extends Error {
    constructor(status, body) {
      super((body && body.message) || ('Ошибка ' + status));
      this.status = status;
      this.code = body && body.error;
      this.body = body;
    }
  }

  async function parse(res) {
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return { message: text }; }
  }

  async function raw(method, path, { body, headers = {}, auth = true } = {}) {
    const h = { ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (auth && accessToken) h['Authorization'] = 'Bearer ' + accessToken;
    return fetch(path, {
      method, headers: h, credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  /** Вызов API; при 401 один раз пробует обновить токен и повторить запрос. */
  async function call(method, path, opts = {}) {
    let res = await raw(method, path, opts);
    if (res.status === 401 && opts.auth !== false && accessToken) {
      if (await refresh()) res = await raw(method, path, opts);
    }
    const data = await parse(res);
    if (!res.ok) throw new ApiError(res.status, data);
    return { status: res.status, data, headers: res.headers };
  }

  function setSession(data) {
    accessToken = data.access_token;
    user = data.user;
  }

  async function login(login, password) {
    const r = await call('POST', '/api/v1/auth/login', { body: { login, password }, auth: false });
    setSession(r.data);
    return user;
  }

  async function refresh() {
    if (!refreshing) {
      refreshing = (async () => {
        const res = await fetch('/api/v1/auth/refresh', {
          method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' },
        });
        if (!res.ok) { accessToken = null; user = null; return false; }
        setSession(await res.json());
        return true;
      })().finally(() => { setTimeout(() => { refreshing = null; }, 0); });
    }
    return refreshing;
  }

  async function logout() {
    try { await call('POST', '/api/v1/auth/logout'); } catch { /* сессия уже недействительна */ }
    accessToken = null; user = null;
  }

  function uuid() { return crypto.randomUUID(); }

  async function sha256Hex(file) {
    const buf = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  return {
    call, login, logout, refresh, uuid, sha256Hex, ApiError,
    get user() { return user; },
    hasRole(r) { return !!user && user.roles.includes(r); },
  };
})();

// Безопасное построение DOM: только textContent, без innerHTML с данными пользователя.
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM: не блокируется CSP (в отличие от атрибута style)
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const STATUS_RU = {
  draft: 'черновик', submitted: 'подана', under_review: 'на рассмотрении',
  approved: 'одобрена', rejected: 'отклонена', withdrawn: 'отозвана',
};
const TYPE_RU = { material_aid: 'материальная поддержка', pgas: 'ПГАС' };
const GROUND_RU = {
  low_income: 'малоимущность', disability: 'инвалидность', orphan: 'сирота', large_family: 'многодетная семья',
  academic_excellence: 'учебная деятельность', science: 'научная деятельность', social_activity: 'общественная деятельность',
  culture: 'культурно-творческая деятельность', sports: 'спортивная деятельность',
};
const DOC_RU = {
  income_certificate: 'справка о доходах', disability_document: 'документ об инвалидности',
  achievement_proof: 'подтверждение достижений', family_composition: 'состав семьи', other: 'другое',
};

function fmtDate(s) { return s ? new Date(s).toLocaleString('ru-RU') : '—'; }

function errorBox(e) {
  const msg = e instanceof Api.ApiError ? `${e.status}: ${e.message}` : String(e.message || e);
  return h('div', { class: 'error' }, msg);
}

/** Короткий номер заявки для интерфейса (последние 12 символов UUID). */
function shortId(id) { return '…' + String(id).slice(-12); }
