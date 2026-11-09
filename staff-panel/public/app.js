// Панель сотрудника: R-03 (reviewer), R-04 (committee_chair), R-07 (support).
// Скрытие кнопок по роли — только удобство: каждое действие сервер проверяет сам (403/404).
'use strict';

const app = document.getElementById('app');
const nav = document.getElementById('nav');
let campaignsCache = null;

function go(hash) { location.hash = hash; }
function view(...nodes) { app.replaceChildren(...nodes); }
const isReviewer = () => Api.hasRole('reviewer');
const isChair = () => Api.hasRole('committee_chair');
const isSupport = () => Api.hasRole('support');

async function campaigns() {
  if (!campaignsCache) campaignsCache = (await Api.call('GET', '/api/v1/campaigns')).data.items;
  return campaignsCache;
}

function renderNav() {
  if (!Api.user) { nav.replaceChildren(); return; }
  const roleRu = { reviewer: 'сотрудник', committee_chair: 'председатель комиссии', support: 'поддержка', applicant: 'заявитель' };
  nav.replaceChildren(
    (isReviewer() || isChair()) ? h('a', { onclick: () => go('#/list') }, 'Заявки') : null,
    (isReviewer() || isChair()) ? h('a', { onclick: () => go('#/ranking') }, 'Рейтинг') : null,
    isChair() ? h('a', { onclick: () => go('#/payout') }, 'Реестр выплат') : null,
    h('a', { onclick: () => go('#/find') }, 'Найти по номеру'),
    h('span', { style: 'color:#cfd8e6;margin-right:12px;font-size:13px' },
      `${Api.user.full_name} (${Api.user.roles.map(r => roleRu[r] || r).join(', ')})`),
    h('button', { onclick: async () => { await Api.logout(); campaignsCache = null; go('#/login'); } }, 'Выйти'),
  );
}

function loginPage() {
  const login = h('input', { autocomplete: 'username', placeholder: 'emp001 / chair001 / sup001' });
  const pwd = h('input', { type: 'password', autocomplete: 'current-password' });
  const out = h('div');
  view(h('div', { class: 'card' }, h('h2', {}, 'Вход сотрудника'),
    h('form', {
      onsubmit: async (e) => {
        e.preventDefault(); out.replaceChildren();
        try { await Api.login(login.value.trim(), pwd.value); route(); } catch (err) { out.append(errorBox(err)); }
      },
    }, h('label', {}, 'Логин'), login, h('label', {}, 'Пароль'), pwd, h('button', { type: 'submit' }, 'Войти')),
    out));
}

// ------------------------------------------------------------------ OP-04 список
async function listPage() {
  let cs;
  try { cs = await campaigns(); } catch (err) { view(errorBox(err)); return; }
  const campaign = h('select', {}, h('option', { value: '' }, 'все кампании'), ...cs.map(c => h('option', { value: c.id }, c.title)));
  const status = h('select', {}, h('option', { value: '' }, 'все статусы'), ...Object.entries(STATUS_RU).map(([k, v]) => h('option', { value: k }, v)));
  const type = h('select', {}, h('option', { value: '' }, 'все виды'), ...Object.entries(TYPE_RU).map(([k, v]) => h('option', { value: k }, v)));
  const sort = h('select', {},
    h('option', { value: '-created_at' }, 'сначала новые'), h('option', { value: 'created_at' }, 'сначала старые'),
    h('option', { value: '-total_score' }, 'по баллам ↓'), h('option', { value: 'total_score' }, 'по баллам ↑'));
  const tbody = h('tbody');
  const more = h('button', { class: 'secondary', style: 'display:none' }, 'Показать ещё');
  const out = h('div');
  let cursor = null;
  async function load(reset) {
    out.replaceChildren();
    if (reset) { tbody.replaceChildren(); cursor = null; }
    const q = new URLSearchParams({ limit: '20', sort: sort.value });
    if (campaign.value) q.set('campaign_id', campaign.value);
    if (status.value) q.set('status', status.value);
    if (type.value) q.set('type', type.value);
    if (cursor) q.set('cursor', cursor);
    try {
      const r = await Api.call('GET', '/api/v1/applications?' + q);
      for (const it of r.data.items) {
        tbody.append(h('tr', { class: 'clickable', onclick: () => go('#/app/' + it.id) },
          h('td', {}, it.id.slice(0, 8)), h('td', {}, it.applicant_name || '—'), h('td', {}, TYPE_RU[it.type]),
          h('td', {}, h('span', { class: 'badge ' + it.status }, STATUS_RU[it.status]))));
      }
      if (!tbody.children.length) tbody.append(h('tr', {}, h('td', { colspan: '4', class: 'muted' }, 'Нет заявок')));
      cursor = r.data.next_cursor || null;
      more.style.display = cursor ? '' : 'none';
    } catch (err) { out.append(errorBox(err)); }
  }
  [campaign, status, type, sort].forEach(s => s.addEventListener('change', () => load(true)));
  more.addEventListener('click', () => load(false));
  view(h('div', { class: 'card' }, h('h2', {}, 'Заявки кампаний подразделения'),
    h('div', { class: 'row' }, campaign, status, type, sort),
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Номер'), h('th', {}, 'Заявитель'), h('th', {}, 'Вид'), h('th', {}, 'Статус'))), tbody),
    more, out));
  await load(true);
}

// ------------------------------------------------------------------ OP-01 карточка + OP-03 проверка
async function appPage(id) {
  let r;
  try { r = await Api.call('GET', `/api/v1/applications/${encodeURIComponent(id)}?include=attachments`); }
  catch (err) { view(h('div', { class: 'card' }, h('h2', {}, 'Заявка'), errorBox(err))); return; }
  const a = r.data;
  // ETag — версия заявки; передаётся в If-Match, чтобы не перезаписать изменения коллеги
  const etag = r.headers.get('ETag');
  const card = h('div', { class: 'card' },
    h('h2', {}, 'Заявка ' + a.id),
    h('div', { class: 'grid' },
      h('div', {}, 'Статус'), h('div', {}, h('span', { class: 'badge ' + a.status }, STATUS_RU[a.status])),
      h('div', {}, 'Вид'), h('div', {}, TYPE_RU[a.type]),
      h('div', {}, 'Заявитель (id)'), h('div', {}, a.applicant_id),
      h('div', {}, 'Кампания (id)'), h('div', {}, a.campaign_id),
      h('div', {}, 'Основания'), h('div', {}, (a.declared_grounds || []).map(g => GROUND_RU[g] || g).join(', ')),
      h('div', {}, 'Подана'), h('div', {}, fmtDate(a.submitted_at)),
      h('div', {}, 'Обоснование'), h('div', { style: 'white-space:pre-wrap' }, a.statement),
      h('div', {}, 'Баллы'), h('div', {}, a.scores ? (a.scores.map(s => `${s.title}: ${s.value} из ${s.max_score}`).join('; ') || '—') : 'нет доступа'),
      h('div', {}, 'Вложения'), h('div', {}, a.attachments
        ? (a.attachments.length ? a.attachments.map(f => h('div', {}, h('a', { href: f.download_url, target: '_blank', rel: 'noopener' }, `${DOC_RU[f.doc_type] || f.doc_type}: ${f.file_name}`))) : '—')
        : 'нет доступа'),
    ));
  const nodes = [card];
  if (isReviewer()) nodes.push(await reviewForm(a, etag));
  view(...nodes);
}

async function reviewForm(a, etag) {
  const out = h('div');
  const c = (await campaigns()).find(x => x.id === a.campaign_id);
  const status = h('select', {}, ...['under_review', 'approved', 'rejected'].map(s => h('option', { value: s }, STATUS_RU[s])));
  const current = Object.fromEntries((a.scores || []).map(s => [s.criterion_id, s.value]));
  const scoreInputs = (c ? c.criteria : []).map(cr => ({
    cr, el: h('input', { type: 'number', min: '0', max: String(cr.max_score), step: '0.01', value: current[cr.id] ?? '' }),
  }));
  const reason = h('textarea', { maxlength: '1000', placeholder: 'Обязательна при отклонении' });
  return h('div', { class: 'card' }, h('h2', {}, 'Проверка (OP-03)'),
    h('form', {
      onsubmit: async (e) => {
        e.preventDefault(); out.replaceChildren();
        const scores = scoreInputs.filter(s => s.el.value !== '').map(s => ({ criterion_id: s.cr.id, value: Number(s.el.value) }));
        const body = { status: status.value };
        if (scores.length) body.scores = scores;
        if (reason.value.trim()) body.reason = reason.value.trim();
        try {
          const r = await Api.call('PATCH', `/api/v1/applications/${a.id}/review`, { headers: { 'If-Match': etag || '' }, body });
          out.append(h('div', { class: 'ok' }, `Сохранено: статус ${STATUS_RU[r.data.status]}, сумма баллов ${r.data.total_score ?? '—'}, версия ${r.data.version}`));
          setTimeout(() => appPage(a.id), 1200);
        } catch (err) { out.append(errorBox(err)); }
      },
    },
      h('label', {}, 'Новый статус'), status,
      scoreInputs.length ? h('label', {}, 'Баллы по критериям') : null,
      ...scoreInputs.map(s => h('div', { class: 'row' }, h('span', {}, `${s.cr.title} (0–${s.cr.max_score})`), s.el)),
      h('label', {}, 'Причина'), reason,
      h('button', { type: 'submit' }, 'Сохранить')),
    out);
}

// ------------------------------------------------------------------ OP-12 рейтинг
async function rankingPage(onLoaded) {
  let cs;
  try { cs = await campaigns(); } catch (err) { view(errorBox(err)); return; }
  const sel = h('select', {}, ...cs.map(c => h('option', { value: c.id }, `${c.title}${c.has_protocol ? ' — протокол утверждён' : ''}`)));
  const box = h('div');
  async function load() {
    box.replaceChildren();
    try {
      const r = await Api.call('GET', `/api/v1/campaigns/${sel.value}/ranking`);
      box.append(h('p', { class: 'muted' }, `Квота: ${r.data.quota}`),
        h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '№'), h('th', {}, 'Заявитель'), h('th', {}, 'Статус'), h('th', {}, 'Баллы'), h('th', {}, 'В квоте'))),
          h('tbody', {}, ...r.data.items.map(it => h('tr', { class: 'clickable', onclick: () => go('#/app/' + it.application_id) },
            h('td', {}, it.rank), h('td', {}, it.applicant_name), h('td', {}, STATUS_RU[it.status]),
            h('td', {}, it.total_score), h('td', {}, it.within_quota ? 'да' : '—'))))));
      if (onLoaded) onLoaded(r.data, cs.find(c => c.id === sel.value));
    } catch (err) { box.append(errorBox(err)); }
  }
  sel.addEventListener('change', load);
  view(h('div', { class: 'card' }, h('h2', {}, onLoaded ? 'Реестр получателей (OP-05)' : 'Ранжированный список (OP-12)'), sel, box));
  await load();
  return { sel, box };
}

// ------------------------------------------------------------------ OP-05 реестр выплат
async function payoutPage() {
  const formBox = h('div', { class: 'card' });
  let ctx = null;
  await rankingPage((data, campaign) => { ctx = { data, campaign }; renderForm(); });
  app.append(formBox);

  function renderForm() {
    formBox.replaceChildren();
    if (!ctx) return;
    const { data, campaign } = ctx;
    const approved = data.items.filter(i => i.status === 'approved');
    // ключ идемпотентности — на одну попытку формирования реестра
    const idemKey = Api.uuid();
    const number = h('input', { placeholder: 'например, П-15' });
    const date = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    const rows = approved.map(i => ({ i, amount: h('input', { type: 'number', step: '0.01', min: String(campaign.min_amount), max: String(campaign.max_amount), value: String(campaign.min_amount) }), on: h('input', { type: 'checkbox', checked: true }) }));
    const out = h('div');
    formBox.append(
      h('h2', {}, 'Формирование реестра'),
      campaign.has_protocol ? h('div', { class: 'ok' }, 'По кампании уже утверждён протокол — повторное формирование будет отклонено (409).') : null,
      h('p', { class: 'muted' }, `Суммы: от ${campaign.min_amount} до ${campaign.max_amount}. В реестр попадают только одобренные заявки этой кампании (проверяется сервером).`),
      h('div', { class: 'row' }, h('div', {}, h('label', {}, 'Номер протокола'), number), h('div', {}, h('label', {}, 'Дата заседания'), date)),
      h('table', {}, h('tbody', {}, ...rows.map(r => h('tr', {}, h('td', {}, r.on), h('td', {}, r.i.applicant_name), h('td', {}, r.amount))))),
      h('button', {
        onclick: async () => {
          out.replaceChildren();
          // повторный ввод пароля (не старше 5 минут) — операция с финансовыми последствиями
          const pwd = prompt('Подтвердите личность: введите пароль');
          if (!pwd) return;
          try {
            await Api.call('POST', '/api/v1/auth/reauth', { body: { password: pwd } });
            const body = {
              protocol_number: number.value.trim(), protocol_date: date.value,
              entries: rows.filter(r => r.on.checked).map(r => ({ application_id: r.i.application_id, amount: Number(r.amount.value) })),
            };
            const r = await Api.call('POST', `/api/v1/campaigns/${campaign.id}/payout-registry`, { headers: { 'Idempotency-Key': idemKey }, body });
            out.append(h('div', { class: 'ok' }, `${r.status === 201 ? 'Реестр сформирован' : 'Повтор: возвращён ранее сформированный реестр'}\n` +
              `Строк: ${r.data.entries_count}, сумма: ${r.data.total_amount}\nКонтрольная сумма SHA-256: ${r.data.checksum}`));
            campaignsCache = null;
          } catch (err) { out.append(errorBox(err)); }
        },
      }, 'Сформировать реестр'),
      out);
  }
}

// ------------------------------------------------------------------ поиск по номеру (R-07 и все)
function findPage() {
  const id = h('input', { placeholder: 'полный идентификатор заявки (UUID)' });
  view(h('div', { class: 'card' }, h('h2', {}, 'Заявка по номеру'),
    h('form', { onsubmit: (e) => { e.preventDefault(); go('#/app/' + id.value.trim()); } }, id, h('button', { type: 'submit' }, 'Открыть'))));
}

async function route() {
  const path = location.hash.slice(1);
  if (!Api.user && !(await Api.refresh())) { renderNav(); return loginPage(); }
  renderNav();
  if (path.startsWith('/app/')) return appPage(path.slice(5));
  if (path === '/ranking') return rankingPage();
  if (path === '/payout') return payoutPage();
  if (path === '/find') return findPage();
  if (path === '/list' || isReviewer() || isChair()) return listPage();
  return findPage();
}

window.addEventListener('hashchange', route);
route();
