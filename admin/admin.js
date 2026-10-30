import { h, formatDate, formatMoney, formatSize } from '/js/dom.js';

const $ = (sel) => document.querySelector(sel);
const view = $('#view');
const REFRESH_MS = 8000;
const TABS = [
  ['overview', 'Overview'],
  ['people', 'Participants'],
  ['rates', 'Exchange rates'],
  ['exports', 'Print & export'],
  ['project', 'Project'],
];

let config = null;
let overview = null; // every project, and which one phones submit to
let data = null; // the project being viewed
let search = '';
let filter = 'all';
let formDirty = false; // unsaved project form: pause auto-refresh
let locked = true; // until the PIN is entered

// ---------- helpers ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'X-Admin': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && json.locked) showLock();
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

// ---------- PIN lock ----------

function showLock(message = '') {
  locked = true;
  for (const el of document.querySelectorAll('.bar-controls > *')) el.hidden = true;
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  const pin = h('input', {
    type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: 12, required: true,
    class: 'pin-input', 'aria-label': 'PIN', 'data-key': 'pin',
  });
  const error = h('p', { class: 'error', role: 'alert', hidden: !message }, message);
  const form = h('form', {
    class: 'card pin-card',
    onsubmit: async (e) => {
      e.preventDefault();
      const button = e.submitter;
      button.disabled = true;
      try {
        const res = await fetch('/api/admin/unlock', {
          method: 'POST',
          headers: { 'X-Admin': '1', 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: pin.value }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || 'Could not unlock.');
        unlockDone();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        pin.value = '';
        pin.focus();
      } finally {
        button.disabled = false;
      }
    },
  },
    h('div', { class: 'pin-icon', 'aria-hidden': 'true' }, '🔒'),
    h('h2', {}, 'Admin view'),
    h('p', { class: 'hint' }, 'Enter the PIN to continue.'),
    pin,
    error,
    h('button', { class: 'button primary wide', type: 'submit' }, 'Unlock'),
  );
  view.replaceChildren(form);
  pin.focus();
}

function unlockDone() {
  locked = false;
  for (const el of document.querySelectorAll('.bar-controls > *')) el.hidden = false;
  load().catch((err) => toast(err.message, 'error'));
}

$('#lock').addEventListener('click', async () => {
  await fetch('/api/admin/lock', { method: 'POST', headers: { 'X-Admin': '1' } }).catch(() => {});
  showLock();
});

let toastTimer;
function toast(message, kind = 'ok') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 6000 : 2200);
}

const eur = (value) => `${formatMoney(value)} EUR`;
const titleCase = (t) => (t ? t[0] + t.slice(1).toLowerCase() : '');

function eventDates(p) {
  if (!p.startDate || !p.endDate) return 'dates not set';
  return `${formatDate(p.startDate)} – ${formatDate(p.endDate)}`;
}

// ---------- routing ----------
// #new · #p=<project>/<tab> · #p=<project>/user=<participant>

function route() {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash === 'new') return { page: 'new' };
  const m = /^p=([^/]+)(?:\/(.+))?$/.exec(hash);
  if (!m) return { page: 'tab', tab: 'overview', projectId: null };
  if (m[2]?.startsWith('user=')) return { page: 'user', projectId: m[1], userId: m[2].slice(5) };
  return { page: 'tab', projectId: m[1], tab: TABS.some(([t]) => t === m[2]) ? m[2] : 'overview' };
}

function go(hash) {
  if (location.hash.slice(1) === hash) render();
  else location.hash = hash;
}
const pid = () => route().projectId || overview.activeProjectId || overview.projects.at(-1)?.id;
const tabHref = (tab) => `#p=${pid()}/${tab}`;
const userHref = (u) => `#p=${pid()}/user=${u.id}`;
const projectUrl = (path = '') => `/api/admin/projects/${pid()}${path}`;

// ---------- loading and rendering ----------

async function load() {
  overview = await api('GET', '/api/admin/overview');
  const id = pid();
  data = id && overview.projects.some((p) => p.id === id) ? await api('GET', `/api/admin/projects/${id}`) : null;
  render();
}

// Saves a change, then reloads so totals and statuses stay correct.
async function save(action, message = 'Saved') {
  try {
    await action();
    toast(message);
  } catch (err) {
    toast(err.message, 'error');
  }
  formDirty = false;
  await load();
}

function render() {
  // Keep the cursor where it was across re-renders.
  // Keep what is being typed too: a save of another field may re-render meanwhile.
  const active = document.activeElement?.dataset?.key;
  const selection = active && document.activeElement.selectionStart;
  const typing = active && document.activeElement.value;
  const scroll = window.scrollY;

  renderBar();
  const r = route();
  let content;
  if (!overview.projects.length) content = renderProjectForm(null, true);
  else if (r.page === 'new') content = renderProjectForm(null, false);
  else if (!data) content = [h('p', { class: 'empty' }, 'Project not found.')];
  else if (r.page === 'user') content = renderUser(data.users.find((u) => u.id === r.userId));
  else content = [renderProjectHead(r.tab), ...renderTab(r.tab)];
  view.replaceChildren(...content.filter(Boolean));

  window.scrollTo(0, scroll);
  if (active) {
    const el = view.querySelector(`[data-key="${CSS.escape(active)}"]`);
    if (el) {
      if (typeof typing === 'string' && el.value !== typing) el.value = typing;
      el.focus();
      if (typeof selection === 'number' && el.setSelectionRange) el.setSelectionRange(selection, selection);
    }
  }
}

function renderBar() {
  if (locked) return;
  const select = $('#project-switch');
  const hasProjects = overview.projects.length > 0;
  select.hidden = !hasProjects;
  $('#new-project').hidden = !hasProjects;
  select.replaceChildren(
    ...[...overview.projects].reverse().map((p) =>
      h('option', { value: p.id, selected: p.id === pid() }, `${p.id === overview.activeProjectId ? '● ' : ''}${p.title} (${eventDates(p)})`)),
  );
}

$('#project-switch').addEventListener('change', (e) => go(`p=${e.target.value}/overview`));
$('#new-project').addEventListener('click', () => go('new'));

function tile(label, value, extra = '', hint = null) {
  return h('div', { class: `tile ${extra}` }, h('span', { class: 'muted' }, label), h('strong', {}, value), hint && h('span', { class: 'tile-hint' }, hint));
}

// ---------- project header and tabs ----------

function renderProjectHead(tab) {
  const p = data.project;
  const active = p.id === overview.activeProjectId;
  const unchecked = data.users.filter((u) => !u.reviewed).length;
  return h('div', { class: 'project-head' },
    h('div', { class: 'project-title' },
      h('h1', {}, p.title),
      h('p', { class: 'muted' }, `${p.projectNumber} · ${eventDates(p)} · ${p.hostCountry}`),
    ),
    active
      ? h('span', { class: 'status-pill ok' }, '● Active – phones send here')
      : h('div', { class: 'inactive-note' },
          h('span', { class: 'status-pill warn' }, 'Not active – phones do not send here'),
          h('button', { class: 'button', type: 'button', onclick: activate }, 'Make active'),
        ),
    h('nav', { class: 'tabs' },
      TABS.map(([id, label]) =>
        h('a', { href: tabHref(id), class: id === tab ? 'current' : '' },
          label,
          id === 'people' && unchecked ? h('span', { class: 'count' }, String(unchecked)) : null,
          id === 'rates' && data.totals.missingRates.length ? h('span', { class: 'count warn' }, '!') : null,
        )),
    ),
  );
}

function activate() {
  save(() => api('POST', projectUrl('/activate')), 'Phones now send to this project');
}

function renderTab(tab) {
  if (tab === 'people') return renderPeople();
  if (tab === 'rates') return renderRates();
  if (tab === 'exports') return renderExports();
  if (tab === 'project') return renderProjectTab();
  return renderOverview();
}

// ---------- overview: what to do next ----------

function renderOverview() {
  const { totals, users, project } = data;
  const checked = users.filter((u) => u.reviewed).length;
  const nextToCheck = users.find((u) => !u.reviewed);
  const toCollect = users.filter((u) => receiptsToCollect(u).length);
  const active = project.id === overview.activeProjectId;
  const step = (done, title, text, action) =>
    h('li', { class: done === true ? 'done' : done === 'warn' ? 'warn' : '' },
      h('span', { class: 'step-mark' }, done === true ? '✓' : done === 'warn' ? '!' : ''),
      h('div', { class: 'step-text' }, h('strong', {}, title), h('span', { class: 'muted' }, text)),
      action,
    );
  const link = (label, href, primary = false, onclick = null) => h('a', { class: `button ${primary ? 'primary' : ''}`, href, onclick }, label);

  return [
    h('div', { class: 'tiles' },
      tile('Participants', String(totals.userCount)),
      tile('Receipts counted', String(totals.receiptCount)),
      tile('Checked', `${checked} of ${users.length}`, checked === users.length && users.length ? 'good' : ''),
      tile('Group total', eur(totals.totalEur), 'accent'),
    ),
    h('section', { class: 'card' },
      h('h2', {}, 'What to do'),
      h('ol', { class: 'checklist' },
        step(true, 'Project details', `${project.title} · ${project.projectNumber} · ${eventDates(project)}`, link('Edit', tabHref('project'))),
        step(
          totals.missingRates.length ? 'warn' : Object.keys(project.rates).length || totals.receiptCount ? true : false,
          'Exchange rates',
          totals.missingRates.length
            ? `Missing for ${totals.missingRates.join(', ')}. Those receipts are not counted yet.`
            : Object.keys(project.rates).length ? 'Set for every currency used so far.' : 'Enter them now or once receipts arrive.',
          link('Set rates', tabHref('rates'), totals.missingRates.length > 0),
        ),
        step(
          users.length > 0,
          'Participants send their receipts',
          active
            ? `${users.length} sent so far. Phones join the same Wi-Fi as the tablet and scan the QR code.`
            : 'This project is not active, so phones cannot send to it.',
          active
            ? h('button', { class: 'button', type: 'button', onclick: showQr }, 'Show QR code')
            : h('button', { class: 'button', type: 'button', onclick: activate }, 'Make active'),
        ),
        step(
          users.length > 0 && checked === users.length,
          'Check each participant',
          users.length ? `${checked} of ${users.length} checked. Compare each receipt with its photo and fix anything wrong.` : 'Nothing to check yet.',
          nextToCheck ? link('Check next', userHref(nextToCheck), true) : null,
        ),
        toCollect.length
          ? step('warn', 'Collect the missing receipts',
              collectText(toCollect),
              link('See who', tabHref('people'), false, () => (filter = 'collect')))
          : null,
        step(false, 'Print the forms and export', 'Print the forms for signing and save the Excel and ZIP files.', link('Print & export', tabHref('exports'))),
      ),
    ),
  ];
}

// ---------- participants ----------

// Journeys sent without a receipt that has not been handed in yet.
function receiptsToCollect(u) {
  return u.receipts.filter((r) => r.status === 'accepted' && !r.file && !r.paperReceived);
}

function problems(u) {
  const list = [];
  const missing = receiptsToCollect(u).length;
  if (missing) list.push(`${missing} receipt${missing === 1 ? '' : 's'} to collect`);
  if (u.missingRates.length) list.push(`no rate: ${u.missingRates.join(', ')}`);
  const incomplete = u.receipts.filter((r) => r.status === 'accepted' && (!r.date || !r.transport || !r.fromCity || !r.toCity)).length;
  if (incomplete) list.push(`${incomplete} incomplete receipt${incomplete === 1 ? '' : 's'}`);
  return list;
}

function collectText(users) {
  const n = users.reduce((sum, u) => sum + receiptsToCollect(u).length, 0);
  const who = users.map((u) => `${u.firstName} ${u.lastName}`).join(', ');
  return `${n} journey${n === 1 ? ' was' : 's were'} sent without a receipt (${who}). Add a photo when you get ${n === 1 ? 'it' : 'them'}, or tick “Received on paper”.`;
}

function renderPeople() {
  const counts = {
    all: data.users.length,
    todo: data.users.filter((u) => !u.reviewed).length,
    checked: data.users.filter((u) => u.reviewed).length,
    problems: data.users.filter((u) => problems(u).length).length,
    collect: data.users.filter((u) => receiptsToCollect(u).length).length,
  };
  const term = search.toLowerCase();
  const users = data.users
    .filter((u) => filter === 'all' || (filter === 'todo' && !u.reviewed) || (filter === 'checked' && u.reviewed) || (filter === 'problems' && problems(u).length) || (filter === 'collect' && receiptsToCollect(u).length))
    .filter((u) => !term || `${u.firstName} ${u.lastName} ${u.email} ${u.country}`.toLowerCase().includes(term));

  const searchBox = h('input', {
    type: 'search', placeholder: 'Search name, email, country', value: search, 'data-key': 'search',
    oninput: (e) => {
      search = e.target.value;
      render();
    },
  });
  const filters = h('div', { class: 'segmented' },
    [['all', 'All'], ['todo', 'To check'], ['checked', 'Checked'], ['collect', 'Receipts to collect'], ['problems', 'Problems']].map(([id, label]) =>
      h('button', { type: 'button', class: id === filter ? 'on' : '', onclick: () => ((filter = id), render()) }, `${label} (${counts[id]})`)),
  );

  if (!data.users.length) {
    return [h('section', { class: 'card empty-card' },
      h('h2', {}, 'No participants yet'),
      h('p', { class: 'muted' }, 'When phones send their forms they appear here.'),
      h('button', { class: 'button primary', type: 'button', onclick: showQr }, 'Show QR code'),
    )];
  }
  return [
    h('section', { class: 'card' },
      h('div', { class: 'toolbar' }, filters, searchBox),
      users.length
        ? h('div', { class: 'table-wrap' },
            h('table', { class: 'users' },
              h('thead', {}, h('tr', {}, ['No.', 'Name', 'Country', 'Receipts', 'Reimbursed', 'Status'].map((t) => h('th', {}, t)))),
              h('tbody', {}, users.map((u) =>
                h('tr', { onclick: () => go(userHref(u).slice(1)) },
                  h('td', { class: 'muted' }, String(u.number)),
                  h('td', {}, h('a', { href: userHref(u) }, `${u.lastName}, ${u.firstName}`)),
                  h('td', {}, u.country),
                  h('td', {}, `${u.acceptedCount}${u.rejectedCount ? ` (+${u.rejectedCount} rejected)` : ''}`),
                  h('td', { class: 'num' }, eur(u.totalEur), u.capped ? h('span', { class: 'badge' }, 'capped') : null),
                  h('td', {},
                    u.reviewed ? h('span', { class: 'badge ok' }, '✓ Checked') : h('span', { class: 'badge' }, 'To check'),
                    problems(u).map((p) => h('span', { class: 'badge warn' }, p)),
                  ),
                ))),
            ),
          )
        : h('p', { class: 'empty' }, 'Nobody matches.'),
    ),
  ];
}

// ---------- exchange rates ----------

function renderRates() {
  const usage = {};
  for (const u of data.users) for (const r of u.receipts) if (r.currency !== 'EUR') usage[r.currency] = (usage[r.currency] || 0) + 1;
  const all = data.currencies.filter((c) => c !== 'EUR');
  const used = all.filter((c) => usage[c]);
  const other = all.filter((c) => !usage[c]);

  const saveRate = (code, input) => {
    const rates = { ...data.project.rates, [code]: input.value.trim() };
    save(() => api('PUT', projectUrl('/rates'), { rates }), input.value.trim() ? `Rate for ${code} saved` : `Rate for ${code} removed`);
  };
  const row = (code) => {
    const input = h('input', {
      inputmode: 'decimal', value: data.project.rates[code] ?? '', placeholder: 'not set', 'data-key': `rate-${code}`,
      onchange: (e) => saveRate(code, e.target),
    });
    const missing = usage[code] && !data.project.rates[code];
    return h('div', { class: `rate-row ${missing ? 'missing' : ''}` },
      h('span', { class: 'rate-eq' }, '1 EUR ='),
      input,
      h('strong', { class: 'rate-code' }, code),
      h('span', { class: 'muted' }, usage[code] ? `${usage[code]} receipt${usage[code] === 1 ? '' : 's'}` : ''),
      missing ? h('span', { class: 'badge warn' }, 'needed') : null,
    );
  };

  return [
    h('section', { class: 'card' },
      h('h2', {}, 'Exchange rates for this project'),
      h('p', { class: 'hint' }, 'Enter how much of each currency one euro buys, e.g. 1 EUR = 395.50 HUF. Changes are saved as soon as you leave the box, and every total updates.'),
      used.length ? h('h3', {}, 'Currencies on the receipts') : h('p', { class: 'muted' }, 'No receipts in other currencies yet.'),
      used.length ? h('div', { class: 'rate-list' }, used.map(row)) : null,
      h('details', { class: 'more', open: !used.length },
        h('summary', {}, 'Other currencies'),
        h('div', { class: 'rate-list' }, other.map(row)),
      ),
    ),
  ];
}

// ---------- exports ----------

function renderExports() {
  const { totals, users } = data;
  const unchecked = users.filter((u) => !u.reviewed).length;
  const card = (title, text, href, label, primary) =>
    h('div', { class: 'export-card' },
      h('h3', {}, title),
      h('p', { class: 'muted' }, text),
      h('a', { class: `button ${primary ? 'primary' : ''} wide`, href }, label),
    );
  return [
    totals.missingRates.length
      ? h('p', { class: 'warning' }, `Exchange rates are missing for ${totals.missingRates.join(', ')}: those receipts are left out. `, h('a', { href: tabHref('rates') }, 'Set rates'))
      : null,
    unchecked ? h('p', { class: 'warning soft' }, `${unchecked} participant${unchecked === 1 ? ' has' : 's have'} not been checked yet.`) : null,
    users.some((u) => receiptsToCollect(u).length)
      ? h('p', { class: 'warning soft' }, 'Some receipts have not been handed in yet. Their journeys are on the forms, but the ZIP only has the receipts you already have.')
      : null,
    h('div', { class: 'export-grid' },
      card('Forms to print', 'One “Travel costs reimbursement form” per participant, one page each, ready to print and sign.', projectUrl('/export/forms.pdf'), 'Download forms (PDF)', true),
      card('Excel summary', 'One row per participant with their total, the group total, every receipt, and the rates used.', projectUrl('/export/summary.xlsx'), 'Download Excel'),
      card('Everything (ZIP)', 'All original receipts in folders by country and participant, with each form, the PDF and the Excel.', projectUrl('/export/archive.zip'), 'Download ZIP'),
    ),
  ];
}

// ---------- project settings ----------

function renderProjectForm(project, first) {
  const fields = {};
  const input = (key, attrs) =>
    (fields[key] = h('input', { value: project?.[key] || '', required: true, oninput: () => (formDirty = true), ...attrs }));
  fields.hostCountry = h('select', { required: true, onchange: () => (formDirty = true) },
    h('option', { value: '' }, 'Choose…'),
    config.HOST_COUNTRIES.map((c) => h('option', { value: c, selected: c === project?.hostCountry }, c)),
  );
  const form = h('form', {
    class: 'grid two',
    onsubmit: (e) => {
      e.preventDefault();
      const body = Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value]));
      e.submitter.disabled = true;
      (project
        ? api('PATCH', `/api/admin/projects/${project.id}`, body).then(() => toast('Project details saved'))
        : api('POST', '/api/admin/projects', body).then(({ id }) => {
            toast('Project created. Phones now send to it.');
            location.hash = `p=${id}/overview`;
          }))
        .then(() => {
          formDirty = false;
          return load();
        })
        .catch((err) => toast(err.message, 'error'))
        .finally(() => (e.submitter.disabled = false));
    },
  },
    h('label', { class: 'span-2' }, 'Project title (as printed on the form)', input('title', { placeholder: 'e.g. A Taste of Europe', maxlength: 200 })),
    h('label', {}, 'Project number', input('projectNumber', { placeholder: 'e.g. No2026-1-BG01-KA151-YOU-000391902', maxlength: 100 })),
    h('label', {}, 'Host country', fields.hostCountry),
    h('label', {}, 'First day', input('startDate', { type: 'date' })),
    h('label', {}, 'Last day (printed as the date on every form)', input('endDate', { type: 'date' })),
    h('div', { class: 'form-end span-2' },
      h('button', { class: 'button primary', type: 'submit' }, project ? 'Save project details' : 'Create project'),
      !project && !first ? h('a', { class: 'button', href: data ? tabHref('overview') : '#' }, 'Cancel') : null,
    ),
  );
  if (project) return form;
  return [
    h('section', { class: `card ${first ? 'welcome' : ''}` },
      h('h2', {}, first ? 'Welcome! Set up your project' : 'New project'),
      h('p', { class: 'hint' }, first
        ? 'Enter the details of this event. They are printed on every participant’s form, and phones can start sending once the project is created.'
        : 'The new project starts empty and phones will send to it. All earlier projects stay saved: open them any time from the list at the top.'),
      form,
    ),
  ];
}

function renderProjectTab() {
  const p = data.project;
  const active = p.id === overview.activeProjectId;
  const phone = h('input', { value: overview.settings.phoneUrl || '', placeholder: 'Automatic', 'data-key': 'phone-url' });
  return [
    h('section', { class: 'card' }, h('h2', {}, 'Project details'), renderProjectForm(p, false)),
    h('section', { class: 'card' },
      h('h2', {}, 'Phones'),
      active
        ? h('p', {}, '● This is the active project: phones send their forms here.')
        : h('div', { class: 'inline-actions' }, h('p', {}, 'This project is not active.'), h('button', { class: 'button primary', type: 'button', onclick: activate }, 'Make active')),
      h('label', {}, 'Address phones open (leave empty unless the QR code shows a wrong address)',
        h('div', { class: 'inline-actions' }, phone,
          h('button', { class: 'button', type: 'button', onclick: () => save(() => api('PUT', '/api/admin/settings', { phoneUrl: phone.value.trim() }), 'Phone address saved') }, 'Save'))),
    ),
    h('section', { class: 'card' },
      h('h2', {}, 'All projects'),
      h('p', { class: 'hint' }, 'Projects are never deleted. Open any of them to view, edit or export.'),
      h('div', { class: 'table-wrap' },
        h('table', { class: 'users' },
          h('thead', {}, h('tr', {}, ['Project', 'Dates', 'Participants', 'Total', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, [...overview.projects].reverse().map((x) =>
            h('tr', { onclick: () => go(`p=${x.id}/overview`) },
              h('td', {}, h('a', { href: `#p=${x.id}/overview` }, x.title), x.id === overview.activeProjectId ? h('span', { class: 'badge ok' }, 'active') : null),
              h('td', {}, eventDates(x)),
              h('td', {}, `${x.userCount} (${x.reviewedCount} checked)`),
              h('td', { class: 'num' }, eur(x.totalEur)),
              h('td', {}, x.id === p.id ? h('span', { class: 'muted' }, 'viewing') : null),
            ))),
        ),
      ),
      h('button', { class: 'button', type: 'button', onclick: () => go('new') }, '+ Start a new project'),
    ),
  ];
}

// ---------- one participant ----------

function renderUser(user) {
  if (!user) return [h('p', { class: 'empty' }, 'Participant not found. ', h('a', { href: tabHref('people') }, 'Back to participants'))];
  const index = data.users.indexOf(user);
  const prev = data.users[index - 1];
  const next = data.users[index + 1];
  const nextUnchecked = data.users.slice(index + 1).find((u) => !u.reviewed) || data.users.slice(0, index).find((u) => !u.reviewed);
  const userUrl = (path) => projectUrl(`/users/${user.id}${path}`);
  const patchUser = (body, message) => save(() => api('PATCH', userUrl(''), body), message);

  const detail = (key, label, input) => {
    input.dataset.key = `user-${key}`;
    input.addEventListener('change', () => patchUser({ [key]: input.value }, `${label} saved`));
    return h('label', {}, label, input);
  };

  const toggleChecked = () => {
    const nowChecked = !user.reviewed;
    save(() => api('PATCH', userUrl(''), { reviewed: nowChecked }), nowChecked ? `${user.firstName} marked as checked` : 'Marked as not checked').then(() => {
      if (nowChecked && nextUnchecked) go(userHref(nextUnchecked).slice(1));
    });
  };

  const remove = () => {
    if (!confirm(`Delete ${user.firstName} ${user.lastName} and all their receipt files? This cannot be undone.`)) return;
    save(() => api('DELETE', userUrl('')), 'Participant deleted').then(() => go(tabHref('people').slice(1)));
  };

  return [
    h('div', { class: 'user-nav' },
      h('a', { href: tabHref('people'), class: 'back' }, '← All participants'),
      h('div', { class: 'pager' },
        h('a', { class: `button ${prev ? '' : 'disabled'}`, href: prev ? userHref(prev) : undefined }, '‹ Previous'),
        h('span', { class: 'muted' }, `${index + 1} of ${data.users.length}`),
        h('a', { class: `button ${next ? '' : 'disabled'}`, href: next ? userHref(next) : undefined }, 'Next ›'),
      ),
    ),
    h('div', { class: `user-head ${user.reviewed ? 'checked' : ''}` },
      h('div', {},
        h('h1', {}, `${user.firstName} ${user.lastName}`),
        h('p', { class: 'muted' }, `No. ${user.number} · ${user.country} · sent ${new Date(user.submittedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`),
      ),
      h('div', { class: 'actions' },
        h('a', { class: 'button', href: userUrl('/form.pdf') }, 'Form (PDF)'),
        user.reviewed
          ? h('button', { class: 'button ok-button', type: 'button', onclick: toggleChecked, title: 'Click to undo' }, '✓ Checked')
          : h('button', { class: 'button primary', type: 'button', onclick: toggleChecked }, nextUnchecked ? 'Mark as checked & next' : 'Mark as checked'),
      ),
    ),
    problems(user).length ? h('p', { class: 'warning' }, `Needs attention: ${problems(user).join('; ')}.`) : null,
    h('div', { class: 'tiles' },
      tile('Receipts counted', `${user.acceptedCount}${user.rejectedCount ? ` (+${user.rejectedCount} rejected)` : ''}`),
      tile('Sum of receipts', eur(user.sumEur)),
      tile('Cap', user.capEur === null ? 'none' : eur(user.capEur), user.capped ? 'warn' : ''),
      tile('To reimburse', eur(user.totalEur), 'accent'),
    ),
    h('section', { class: 'card' },
      h('h2', {}, `Receipts (${user.receipts.length})`),
      h('p', { class: 'hint' }, 'Each receipt is one row on the form. Tap a picture to enlarge it. Changes are saved automatically.'),
      h('ol', { class: 'admin-receipts' }, user.receipts.map((r) => renderReceipt(user, r))),
    ),
    h('section', { class: 'card' },
      h('h2', {}, 'Personal details'),
      h('div', { class: 'grid two' },
        detail('firstName', 'First name', h('input', { value: user.firstName })),
        detail('lastName', 'Last name', h('input', { value: user.lastName })),
        detail('dob', 'Date of birth', h('input', { type: 'date', value: user.dob })),
        detail('email', 'Email', h('input', { type: 'email', value: user.email })),
        detail('country', 'Country', h('select', {}, config.COUNTRIES.map((c) => h('option', { value: c, selected: c === user.country }, c)))),
        detail('capEur', 'Maximum reimbursement in EUR (empty = no cap)', h('input', { inputmode: 'decimal', value: user.capEur ?? '', placeholder: 'No cap' })),
      ),
    ),
    h('section', { class: 'card danger-zone' },
      h('h2', {}, 'Delete participant'),
      h('p', { class: 'hint' }, 'Removes this person and their receipt files from the project. This cannot be undone.'),
      h('button', { class: 'button danger', type: 'button', onclick: remove }, 'Delete participant'),
    ),
  ];
}

// Adds the photo or PDF of a receipt handed in after the form was sent.
function attachReceipt(user, r) {
  const input = h('input', { type: 'file', accept: 'image/*,application/pdf,.pdf,.heic,.heif' });
  input.addEventListener('change', () => {
    if (!input.files[0]) return;
    const body = new FormData();
    body.append('file0', input.files[0], input.files[0].name);
    save(async () => {
      const res = await fetch(projectUrl(`/users/${user.id}/receipts/${r.id}/file`), { method: 'POST', headers: { 'X-Admin': '1' }, body });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Upload failed.');
    }, `Receipt ${r.number} added`);
  });
  input.click();
}

function renderReceipt(user, r) {
  const file = projectUrl(`/users/${user.id}/receipts/${r.id}/file`);
  const patch = (body, message = 'Saved') => save(() => api('PATCH', projectUrl(`/users/${user.id}/receipts/${r.id}`), body), message);
  const field = (name, label, input, cls = '') => {
    input.dataset.key = `${r.id}-${name}`;
    input.addEventListener('change', () => patch({ [name]: input.value }, `Receipt ${r.number}: ${label.toLowerCase()} saved`));
    return h('label', { class: cls }, label, input);
  };
  const countrySelect = (value) => {
    const list = data.project.routeCountries;
    const options = value && !list.includes(value) ? [...list, value] : list;
    return h('select', {}, h('option', { value: '' }, '—'), options.map((c) => h('option', { value: c, selected: c === value }, c)));
  };
  const isImage = r.file && r.file.mime.startsWith('image/') && r.file.mime !== 'image/heic';
  const preview = !r.file
    ? h('div', { class: `preview missing ${r.paperReceived ? 'paper' : ''}` },
        h('span', { class: 'missing-icon' }, r.paperReceived ? '✓' : '!'),
        h('span', {}, r.paperReceived ? 'Received on paper' : 'No receipt yet'),
        h('button', { type: 'button', class: 'button small-button', onclick: () => attachReceipt(user, r) }, 'Add photo / PDF'),
      )
    : isImage
    ? h('button', { type: 'button', class: 'preview', onclick: () => openViewer(file, `Receipt ${r.number} · ${r.file.originalName}`) },
        h('img', { src: file, alt: `Receipt ${r.number}`, loading: 'lazy' }), h('span', { class: 'zoom' }, 'Enlarge'))
    : h('a', { href: file, target: '_blank', class: 'preview doc' }, r.file.mime === 'application/pdf' ? 'PDF' : 'HEIC', h('span', { class: 'zoom' }, 'Open'));

  const s = r.submitted || {};
  const changed = r.editedAt && ['amount', 'currency', 'date', 'transport', 'fromCity', 'fromCountry', 'toCity', 'toCountry'].some((k) => (s[k] ?? '') !== (r[k] ?? ''));
  const place = (k) => [s[`${k}City`], s[`${k}Country`]].filter(Boolean).join(', ');
  const counted = r.status === 'accepted';

  return h('li', { class: `admin-receipt ${r.status}` },
    preview,
    h('div', { class: 'receipt-form' },
      h('div', { class: 'receipt-top' },
        h('strong', {}, `#${r.number}`),
        r.file
          ? [h('span', { class: 'muted file-name' }, `${r.file.originalName} · ${formatSize(r.file.size)}`), h('a', { href: `${file}?download=1` }, 'Download')]
          : h('label', { class: 'check' },
              h('input', { type: 'checkbox', checked: r.paperReceived, onchange: (e) => patch({ paperReceived: e.target.checked }, e.target.checked ? `Receipt ${r.number} received on paper` : `Receipt ${r.number} marked as missing`) }),
              'Received on paper'),
        h('div', { class: 'segmented small' },
          h('button', { type: 'button', class: counted ? 'on' : '', onclick: () => !counted && patch({ status: 'accepted' }, `Receipt ${r.number} counted`) }, 'Counted'),
          h('button', { type: 'button', class: !counted ? 'on danger' : '', onclick: () => counted && patch({ status: 'rejected' }, `Receipt ${r.number} rejected`) }, 'Rejected'),
        ),
      ),
      h('div', { class: 'receipt-fields' },
        field('fromCity', 'From city', h('input', { value: r.fromCity })),
        field('fromCountry', 'From country', countrySelect(r.fromCountry)),
        field('toCity', 'To city', h('input', { value: r.toCity })),
        field('toCountry', 'To country', countrySelect(r.toCountry)),
        field('transport', 'Transport', h('select', {},
          h('option', { value: '' }, '—'),
          config.TRANSPORT.map((t) => h('option', { value: t, selected: t === r.transport }, titleCase(t))),
        )),
        field('date', 'Date', h('input', { type: 'date', value: r.date || '' })),
        field('amount', 'Amount', h('input', { inputmode: 'decimal', value: r.amount.toFixed(2) })),
        field('currency', 'Currency', h('select', {}, data.currencies.map((c) => h('option', { value: c, selected: c === r.currency }, c)))),
      ),
      h('div', { class: 'receipt-bottom' },
        h('span', { class: 'converted' },
          !counted ? 'Not counted' : r.eur === null ? h('span', { class: 'badge warn' }, `no rate for ${r.currency}`) : `= ${eur(r.eur)}`,
          counted && r.currency !== 'EUR' && r.rate ? h('span', { class: 'muted' }, ` at 1 EUR = ${r.rate} ${r.currency}`) : null,
        ),
        changed
          ? h('span', { class: 'muted small' }, `Participant entered: ${formatMoney(s.amount)} ${s.currency}${s.date ? `, ${formatDate(s.date)}` : ''}${s.transport ? `, ${titleCase(s.transport)}` : ''}${s.fromCity ? `, ${place('from')} → ${place('to')}` : ''}`)
          : null,
      ),
    ),
  );
}

// ---------- photo viewer and QR ----------

let rotation = 0;
function openViewer(src, title) {
  rotation = 0;
  const img = $('#viewer-img');
  img.src = src;
  img.style.transform = '';
  img.classList.remove('zoomed');
  $('#viewer-title').textContent = title;
  $('#viewer-open').href = src;
  $('#viewer').showModal();
}
$('#viewer-rotate').addEventListener('click', () => {
  rotation = (rotation + 90) % 360;
  $('#viewer-img').style.transform = `rotate(${rotation}deg)`;
});
$('#viewer-img').addEventListener('click', (e) => e.target.classList.toggle('zoomed'));

function showQr() {
  $('#qr-list').replaceChildren(
    ...(overview.phoneUrls.length
      ? overview.phoneUrls.map((url) =>
          h('figure', {}, h('img', { src: `/api/admin/qr.svg?url=${encodeURIComponent(url)}`, alt: `QR code for ${url}` }), h('figcaption', {}, url)))
      : [h('p', { class: 'warning' }, 'The tablet did not report its network address. Enter it on the Project tab (see README).')]),
  );
  $('#qr-dialog').showModal();
}
$('#show-qr').addEventListener('click', showQr);

// ---------- start ----------

window.addEventListener('hashchange', () => {
  window.scrollTo(0, 0);
  if (!locked) load().catch((err) => toast(err.message, 'error'));
});

// New submissions appear on their own, unless the admin is in the middle of something.
setInterval(() => {
  const busy = formDirty || document.activeElement?.matches('input, select') || $('#qr-dialog').open || $('#viewer').open;
  if (config && !locked && !document.hidden && !busy) load().catch(() => {});
}, REFRESH_MS);

fetch('/api/config')
  .then((res) => res.json())
  .then(async (json) => {
    config = json;
    const session = await (await fetch('/api/admin/session')).json();
    if (session.unlocked) unlockDone();
    else showLock();
  })
  .catch((err) => {
    view.replaceChildren(h('p', { class: 'error' }, `Could not load data: ${err.message}`));
  });
