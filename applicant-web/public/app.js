// Веб-кабинет заявителя (R-02). Проверки в форме — удобство; все они продублированы на сервере.
'use strict';

const app = document.getElementById('app');
const nav = document.getElementById('nav');

function go(hash) { location.hash = hash; }
function view(...nodes) { app.replaceChildren(...nodes); }

function renderNav() {
  if (!Api.user) { nav.replaceChildren(); return; }
  nav.replaceChildren(
    h('a', { onclick: () => go('#/apps') }, 'Мои заявки'),
    h('a', { onclick: () => go('#/new') }, 'Новая заявка'),
    h('span', { class: 'muted', style: 'color:#cfd8e6;margin-right:12px' }, Api.user.full_name),
    h('button', { onclick: async () => { await Api.logout(); go('#/login'); } }, 'Выйти'),
  );
}

// ------------------------------------------------------------------ вход / регистрация / восстановление
function loginPage(msg) {
  const login = h('input', { autocomplete: 'username', placeholder: 'stud001 или e-mail' });
  const pwd = h('input', { type: 'password', autocomplete: 'current-password' });
  const out = h('div');
  const submit = async (e) => {
    e.preventDefault();
    out.replaceChildren();
    try {
      await Api.login(login.value.trim(), pwd.value);
      if (!Api.hasRole('applicant')) out.append(h('div', { class: 'error' }, 'Это кабинет заявителя. Сотрудникам — панель сотрудника: http://127.0.0.1:8081'));
      else go('#/apps');
    } catch (err) { out.append(errorBox(err)); }
  };
  view(h('div', { class: 'card' },
    h('h2', {}, 'Вход'),
    msg ? h('div', { class: 'ok' }, msg) : null,
    h('form', { onsubmit: submit },
      h('label', {}, 'Логин'), login, h('label', {}, 'Пароль'), pwd,
      h('button', { type: 'submit' }, 'Войти')),
    out,
    h('p', {}, h('a', { href: '#/register' }, 'Регистрация обучающегося'), ' · ', h('a', { href: '#/forgot' }, 'Забыли пароль?')),
  ));
}

function registerPage() {
  const ext = h('input', { placeholder: 'логин из каталога, например stud010' });
  const email = h('input', { type: 'email', placeholder: 'адрес из каталога' });
  const pwd = h('input', { type: 'password', autocomplete: 'new-password', minlength: '10' });
  const out = h('div');
  view(h('div', { class: 'card' },
    h('h2', {}, 'Регистрация'),
    h('p', { class: 'muted' }, 'Доступна действующим обучающимся: логин и e-mail сверяются с корпоративным каталогом. ФИО и подразделение берутся из каталога.'),
    h('form', {
      onsubmit: async (e) => {
        e.preventDefault(); out.replaceChildren();
        try {
          await Api.call('POST', '/api/v1/auth/register', { auth: false, body: { external_id: ext.value.trim(), email: email.value.trim(), password: pwd.value } });
          loginPage('Учётная запись создана — войдите.');
        } catch (err) { out.append(errorBox(err)); }
      },
    }, h('label', {}, 'Логин'), ext, h('label', {}, 'E-mail'), email, h('label', {}, 'Пароль (не короче 10 символов)'), pwd,
      h('button', { type: 'submit' }, 'Зарегистрироваться')),
    out, h('p', {}, h('a', { href: '#/login' }, 'Ко входу')),
  ));
}

function forgotPage() {
  const email = h('input', { type: 'email' });
  const out = h('div');
  view(h('div', { class: 'card' },
    h('h2', {}, 'Восстановление доступа'),
    h('form', {
      onsubmit: async (e) => {
        e.preventDefault(); out.replaceChildren();
        try {
          const r = await Api.call('POST', '/api/v1/auth/password-reset', { auth: false, body: { email: email.value.trim() } });
          out.append(h('div', { class: 'ok' }, r.data.message + ' (локально: http://localhost:8025)'));
        } catch (err) { out.append(errorBox(err)); }
      },
    }, h('label', {}, 'E-mail'), email, h('button', { type: 'submit' }, 'Отправить ссылку')),
    out, h('p', {}, h('a', { href: '#/login' }, 'Ко входу')),
  ));
}

function resetPage(token) {
  const pwd = h('input', { type: 'password', autocomplete: 'new-password' });
  const out = h('div');
  view(h('div', { class: 'card' },
    h('h2', {}, 'Новый пароль'),
    h('form', {
      onsubmit: async (e) => {
        e.preventDefault(); out.replaceChildren();
        try {
          await Api.call('POST', '/api/v1/auth/password-reset/confirm', { auth: false, body: { token, new_password: pwd.value } });
          history.replaceState(null, '', '#/login'); // код из адресной строки убирается
          loginPage('Пароль изменён. Все прежние сессии завершены — войдите с новым паролем.');
        } catch (err) { out.append(errorBox(err)); }
      },
    }, h('label', {}, 'Новый пароль (не короче 10 символов)'), pwd, h('button', { type: 'submit' }, 'Сменить пароль')),
    out,
  ));
}

// ------------------------------------------------------------------ список (OP-04)
async function appsPage() {
  const status = h('select', {}, h('option', { value: '' }, 'все статусы'),
    ...Object.entries(STATUS_RU).map(([k, v]) => h('option', { value: k }, v)));
  const tbody = h('tbody');
  const more = h('button', { class: 'secondary', style: 'display:none' }, 'Показать ещё');
  const out = h('div');
  let cursor = null;

  async function load(reset) {
    out.replaceChildren();
    if (reset) { tbody.replaceChildren(); cursor = null; }
    const q = new URLSearchParams({ limit: '20' });
    if (status.value) q.set('status', status.value);
    if (cursor) q.set('cursor', cursor);
    try {
      const r = await Api.call('GET', '/api/v1/applications?' + q);
      for (const it of r.data.items) {
        tbody.append(h('tr', { class: 'clickable', onclick: () => go('#/app/' + it.id) },
          h('td', {}, shortId(it.id)), h('td', {}, TYPE_RU[it.type] || it.type),
          h('td', {}, h('span', { class: 'badge ' + it.status }, STATUS_RU[it.status] || it.status))));
      }
      if (!tbody.children.length) tbody.append(h('tr', {}, h('td', { colspan: '3', class: 'muted' }, 'Заявок нет')));
      cursor = r.data.next_cursor || null;
      more.style.display = cursor ? '' : 'none';
    } catch (err) { out.append(errorBox(err)); }
  }
  status.addEventListener('change', () => load(true));
  more.addEventListener('click', () => load(false));
  view(h('div', { class: 'card' },
    h('h2', {}, 'Мои заявки'),
    h('div', { class: 'row' }, status),
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Номер'), h('th', {}, 'Вид'), h('th', {}, 'Статус'))), tbody),
    more, out));
  await load(true);
}

// ------------------------------------------------------------------ создание (OP-02)
async function newPage() {
  const out = h('div');
  let campaigns = [];
  try { campaigns = (await Api.call('GET', '/api/v1/campaigns')).data.items; } catch (err) { view(errorBox(err)); return; }
  // Ключ идемпотентности создаётся один раз на открытие формы: повторная отправка
  // (двойной клик, обрыв сети) вернёт ту же заявку, а не создаст вторую.
  const idemKey = Api.uuid();
  const campaign = h('select', {}, ...campaigns.map(c => h('option', { value: c.id }, `${c.title} (${TYPE_RU[c.type]}, до ${fmtDate(c.accepts_until)})`)));
  const statement = h('textarea', { maxlength: '4000', placeholder: 'Обоснование: какие основания, какие документы приложите' });
  const counter = h('span', { class: 'muted' }, '0 / 4000');
  statement.addEventListener('input', () => { counter.textContent = statement.value.length + ' / 4000'; });
  const checks = Object.entries(GROUND_RU).map(([k, v]) => ({ k, el: h('input', { type: 'checkbox', value: k }), v }));
  const btn = h('button', { type: 'submit' }, 'Создать черновик');

  view(h('div', { class: 'card' },
    h('h2', {}, 'Новая заявка'),
    campaigns.length ? null : h('div', { class: 'error' }, 'Сейчас нет кампаний с открытым приёмом'),
    h('form', {
      onsubmit: async (e) => {
        e.preventDefault(); out.replaceChildren();
        const c = campaigns.find(x => x.id === campaign.value);
        const grounds = checks.filter(x => x.el.checked).map(x => x.k);
        if (!grounds.length) { out.append(h('div', { class: 'error' }, 'Отметьте хотя бы одно основание')); return; }
        btn.disabled = true;
        try {
          // в теле — ровно четыре поля контракта; владельца и статус назначает сервер
          const r = await Api.call('POST', '/api/v1/applications', {
            headers: { 'Idempotency-Key': idemKey },
            body: { campaign_id: c.id, type: c.type, statement: statement.value, declared_grounds: grounds },
          });
          go('#/app/' + r.data.id);
        } catch (err) { out.append(errorBox(err)); btn.disabled = false; }
      },
    },
      h('label', {}, 'Кампания'), campaign,
      h('label', {}, 'Обоснование'), statement, counter,
      h('label', {}, 'Заявленные основания'), h('div', { class: 'checks' }, ...checks.map(x => h('label', {}, x.el, x.v))),
      btn),
    out));
}

// ------------------------------------------------------------------ карточка (OP-01, OP-10, OP-13, OP-18, OP-06)
async function appPage(id) {
  let r;
  try { r = await Api.call('GET', `/api/v1/applications/${encodeURIComponent(id)}?include=attachments`); }
  catch (err) { view(h('div', { class: 'card' }, h('h2', {}, 'Заявка'), errorBox(err))); return; }
  const a = r.data;
  const out = h('div');
  const editable = a.status === 'draft' || a.status === 'submitted';

  const act = (label, cls, fn) => h('button', { class: cls, onclick: async () => {
    out.replaceChildren();
    try { await fn(); } catch (err) { out.append(errorBox(err)); }
  } }, label);

  const actions = h('div', {},
    a.status === 'draft' ? act('Подать заявку', '', async () => {
      await Api.call('POST', `/api/v1/applications/${a.id}/submit`); appPage(id);
    }) : null,
    editable ? act(a.status === 'draft' ? 'Удалить черновик' : 'Отозвать заявку', 'danger', async () => {
      if (!confirm('Подтвердите действие')) return;
      await Api.call('DELETE', `/api/v1/applications/${a.id}`);
      go('#/apps');
    }) : null,
    act('Проверить полноту (модель)', 'secondary', async () => {
      await Api.call('POST', `/api/v1/applications/${a.id}/completeness-check`, { headers: { 'Idempotency-Key': Api.uuid() } });
    }),
  );

  const attachments = h('div', {},
    h('h2', {}, 'Вложения'),
    (a.attachments && a.attachments.length)
      ? h('table', {}, h('tbody', {}, ...a.attachments.map(f => h('tr', {},
          h('td', {}, DOC_RU[f.doc_type] || f.doc_type), h('td', {}, f.file_name),
          h('td', {}, Math.round(f.size_bytes / 1024) + ' КБ'),
          h('td', {}, h('a', { href: f.download_url, download: f.file_name }, 'скачать'))))))
      : h('p', { class: 'muted' }, 'Нет вложений'),
    editable ? uploadForm(a.id, () => appPage(id)) : null);

  view(
    h('div', { class: 'card' },
      h('h2', {}, 'Заявка ' + shortId(a.id)),
      h('div', { class: 'grid' },
        h('div', {}, 'Статус'), h('div', {}, h('span', { class: 'badge ' + a.status }, STATUS_RU[a.status] || a.status)),
        h('div', {}, 'Вид поддержки'), h('div', {}, TYPE_RU[a.type] || a.type),
        h('div', {}, 'Основания'), h('div', {}, (a.declared_grounds || []).map(g => GROUND_RU[g] || g).join(', ')),
        h('div', {}, 'Подана'), h('div', {}, fmtDate(a.submitted_at)),
        h('div', {}, 'Обоснование'), h('div', { style: 'white-space:pre-wrap' }, a.statement),
        a.scores ? h('div', {}, 'Баллы') : null,
        a.scores ? h('div', {}, a.scores.map(s => `${s.title}: ${s.value}`).join('; ') || '—') : null,
      ),
      actions, out),
    h('div', { class: 'card' }, attachments));
}

function uploadForm(appId, done) {
  const docType = h('select', {}, ...Object.entries(DOC_RU).map(([k, v]) => h('option', { value: k }, v)));
  const file = h('input', { type: 'file', accept: 'application/pdf,image/jpeg,image/png' });
  const out = h('div');
  return h('form', {
    onsubmit: async (e) => {
      e.preventDefault(); out.replaceChildren();
      const f = file.files[0];
      if (!f) return;
      try {
        // 1) OP-10: сервер проверяет владельца и выдаёт подписанную форму на 15 минут
        const link = (await Api.call('POST', `/api/v1/applications/${appId}/attachments`, {
          body: { doc_type: docType.value, file_name: f.name, content_type: f.type, size_bytes: f.size, sha256: await Api.sha256Hex(f) },
        })).data;
        // 2) B-03: файл уходит прямо в хранилище; размер и тип проверяет политика подписи
        const fd = new FormData();
        for (const [k, v] of Object.entries(link.form_fields)) fd.append(k, v);
        fd.append('file', f);
        const res = await fetch(link.upload_url, { method: 'POST', body: fd });
        if (!res.ok) throw new Error('Хранилище отклонило файл: ' + res.status);
        done();
      } catch (err) { out.append(errorBox(err)); }
    },
  }, h('div', { class: 'row' }, docType, file), h('button', { type: 'submit' }, 'Загрузить (PDF/JPEG/PNG до 10 МБ)'), out);
}

// ------------------------------------------------------------------ маршрутизация
async function route() {
  const [path, query] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(query || '');
  if (path === '/reset') return resetPage(params.get('token') || '');
  if (path === '/register') return registerPage();
  if (path === '/forgot') return forgotPage();
  if (!Api.user && !(await Api.refresh())) { renderNav(); return loginPage(); }
  renderNav();
  if (path === '/new') return newPage();
  if (path.startsWith('/app/')) return appPage(path.slice(5));
  if (path === '/login' && Api.user) return go('#/apps');
  return appsPage();
}

window.addEventListener('hashchange', route);
route();
