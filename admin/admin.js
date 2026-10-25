import { h, formatDate, formatMoney, formatSize } from '/js/dom.js';

const view = document.querySelector('#view');
const REFRESH_MS = 8000;

let config = null;
let overview = null; // all projects + which one phones submit to
let data = null; // the project being viewed
let search = '';
const dirty = new Set(); // forms with unsaved edits; refresh waits for them

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'X-Admin': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

// Hash routes: #new, #edit, #p=<project>, #p=<project>/user=<participant>
function route() {
  const hash = location.hash.slice(1);
  if (hash === 'new' || hash === 'edit') return { page: hash };
  const m = /^p=([^/]+)(?:\/user=(.+))?$/.exec(hash);
  if (m) return { page: m[2] ? 'user' : 'project', projectId: decodeURIComponent(m[1]), userId: m[2] && decodeURIComponent(m[2]) };
  return { page: 'project', projectId: null };
}

function viewedProjectId() {
  const r = route();
  return r.projectId || data?.project.id || overview.activeProjectId;
}

const projectUrl = (path = '') => `/api/admin/projects/${encodeURIComponent(viewedProjectId())}${path}`;
const goProject = (id) => (location.hash = `p=${encodeURIComponent(id)}`);

async function load() {
  overview = await api('GET', '/api/admin/overview');
  const pid = viewedProjectId();
  data = pid && overview.projects.some((p) => p.id === pid) ? await api('GET', `/api/admin/projects/${encodeURIComponent(pid)}`) : null;
  dirty.clear();
  render();
}

async function run(action, button) {
  if (button) button.disabled = true;
  try {
    await action();
    await load();
  } catch (err) {
    alert(err.message);
  } finally {
    if (button) button.disabled = false;
  }
}

const eur = (value) => `${formatMoney(value)} EUR`;

function eventDates(p) {
  if (!p.startDate || !p.endDate) return 'dates not set';
  return `${formatDate(p.startDate)} – ${formatDate(p.endDate)}`;
}

function render() {
  document.querySelector('#phone-url').textContent = overview.phoneUrls[0] || 'address unknown – see Settings';
  const scroll = window.scrollY;
  const r = route();
  let content;
  if (!overview.projects.length) content = renderProjectForm(null);
  else if (r.page === 'new') content = renderProjectForm(null);
  else if (r.page === 'edit' && data) content = renderProjectForm(data.project);
  else if (!data) content = [h('p', { class: 'empty' }, 'Choose a project.'), renderProjectBar()];
  else if (r.page === 'user') {
    const user = data.users.find((u) => u.id === r.userId);
    content = user ? renderUser(user) : renderProject();
  } else content = renderProject();
  view.replaceChildren(...[].concat(content));
  window.scrollTo(0, scroll);
}

function tile(label, value, extra) {
  return h('div', { class: `tile ${extra || ''}` }, h('span', { class: 'muted' }, label), h('strong', {}, value));
}

// ---------- projects ----------

function renderProjectForm(project) {
  const first = !overview.projects.length;
  const fields = {};
  const input = (key, attrs) => (fields[key] = h('input', { value: project?.[key] || '', required: true, ...attrs }));
  const host = (fields.hostCountry = h('select', { required: true },
    h('option', { value: '' }, 'Choose…'),
    config.HOST_COUNTRIES.map((c) => h('option', { value: c, selected: c === project?.hostCountry }, c)),
  ));
  const form = h('form', {
    class: 'grid two',
    onsubmit: (e) => {
      e.preventDefault();
      const body = Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value]));
      run(async () => {
        if (project) {
          await api('PATCH', `/api/admin/projects/${encodeURIComponent(project.id)}`, body);
          goProject(project.id);
        } else {
          const { id } = await api('POST', '/api/admin/projects', body);
          goProject(id);
        }
      }, e.submitter);
    },
  },
    h('label', { class: 'span-2' }, 'Project title (as it appears on the form)', input('title', { placeholder: 'e.g. A Taste of Europe', maxlength: 200 })),
    h('label', {}, 'Project number', input('projectNumber', { placeholder: 'e.g. No2026-1-BG01-KA151-YOU-000391902', maxlength: 100 })),
    h('label', {}, 'Host country', host),
    h('label', {}, 'First day', input('startDate', { type: 'date' })),
    h('label', {}, 'Last day (printed as the date on every form)', input('endDate', { type: 'date' })),
    h('div', { class: 'form-end span-2' },
      h('button', { class: 'button primary', type: 'submit' }, project ? 'Save project details' : 'Create project'),
      !first ? h('a', { class: 'button', href: data ? `#p=${encodeURIComponent(data.project.id)}` : '#' }, 'Cancel') : null,
    ),
  );
  return [
    h('section', { class: 'card' },
      h('h2', {}, project ? 'Edit project details' : first ? 'Set up your project' : 'New project'),
      project
        ? null
        : h('p', { class: 'hint' }, first
          ? 'Enter the details of this event. They are printed on every participant’s form.'
          : 'The new project starts empty and phones will submit to it. Every earlier project stays saved and can be opened again from the project list.'),
      form,
    ),
  ];
}

function renderProjectBar() {
  const p = data?.project;
  const active = p && p.id === overview.activeProjectId;
  const switcher = h('select', {
    'aria-label': 'Open another project',
    onchange: (e) => e.target.value && goProject(e.target.value),
  },
    h('option', { value: '' }, `All projects (${overview.projects.length})…`),
    [...overview.projects].reverse().map((x) =>
      h('option', { value: x.id }, `${x.title} · ${eventDates(x)} · ${x.userCount} people${x.id === overview.activeProjectId ? ' · ACTIVE' : ''}`)),
  );
  const newProject = () => {
    if (!confirm('Start a new project? Phones will then submit to the new project. All current and earlier projects stay saved.')) return;
    location.hash = 'new';
  };
  return h('section', { class: `card project-bar ${active ? 'active' : 'inactive'}` },
    p
      ? h('div', { class: 'project-info' },
          h('div', {},
            h('h2', {}, p.title, active ? h('span', { class: 'badge ok' }, 'Active – phones submit here') : h('span', { class: 'badge warn' }, 'Not active')),
            h('p', { class: 'muted' }, `${p.projectNumber} · ${eventDates(p)} · host: ${p.hostCountry || '—'}`),
          ),
          h('div', { class: 'actions' },
            !active ? h('button', { class: 'button primary', type: 'button', onclick: (e) => run(() => api('POST', projectUrl('/activate')), e.target) }, 'Make active') : null,
            h('a', { class: 'button', href: '#edit' }, 'Edit details'),
          ),
        )
      : null,
    h('div', { class: 'actions project-switch' }, switcher, h('button', { class: 'button', type: 'button', onclick: newProject }, 'New project')),
  );
}

function renderProject() {
  const { totals } = data;
  const missing = totals.missingRates;
  const term = search.toLowerCase();
  const users = data.users.filter((u) => !term || `${u.firstName} ${u.lastName} ${u.email} ${u.country}`.toLowerCase().includes(term));
  const userHref = (u) => `#p=${encodeURIComponent(data.project.id)}/user=${encodeURIComponent(u.id)}`;

  const searchBox = h('input', {
    type: 'search',
    placeholder: 'Search name, email, country',
    value: search,
    oninput: (e) => {
      search = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const box = view.querySelector('input[type=search]');
      box.focus();
      box.setSelectionRange(pos, pos);
    },
  });

  return [
    renderProjectBar(),
    h('div', { class: 'tiles' },
      tile('Participants', String(totals.userCount)),
      tile('Receipts counted', String(totals.receiptCount)),
      tile('Group total', eur(totals.totalEur), 'accent'),
      missing.length ? tile('Missing rates', missing.join(', '), 'warn') : tile('Exchange rates', 'All set'),
    ),
    h('section', { class: 'card' },
      h('h2', {}, 'Exports'),
      h('div', { class: 'actions' },
        h('a', { class: 'button primary', href: projectUrl('/export/forms.pdf') }, 'All forms (one PDF)'),
        h('a', { class: 'button', href: projectUrl('/export/summary.xlsx') }, 'Excel summary'),
        h('a', { class: 'button', href: projectUrl('/export/archive.zip') }, 'Everything (ZIP)'),
      ),
      missing.length ? h('p', { class: 'warning' }, `Receipts in ${missing.join(', ')} are left out of totals until you set their exchange rate.`) : null,
    ),
    renderSettings(missing),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Participants'), searchBox),
      data.users.length
        ? h('div', { class: 'table-wrap' },
            h('table', { class: 'users' },
              h('thead', {}, h('tr', {}, ['No.', 'Name', 'Country', 'Receipts', 'Reimbursed', 'Submitted'].map((t) => h('th', {}, t)))),
              h('tbody', {}, users.map((u) =>
                h('tr', { onclick: () => (location.hash = userHref(u).slice(1)) },
                  h('td', {}, String(u.number)),
                  h('td', {}, h('a', { href: userHref(u) }, `${u.lastName}, ${u.firstName}`)),
                  h('td', {}, u.country),
                  h('td', {}, `${u.acceptedCount}${u.rejectedCount ? ` (+${u.rejectedCount} rejected)` : ''}`),
                  h('td', { class: 'num' }, eur(u.totalEur),
                    u.capped ? h('span', { class: 'badge' }, 'capped') : null,
                    u.missingRates.length ? h('span', { class: 'badge warn' }, `no rate: ${u.missingRates.join(', ')}`) : null),
                  h('td', {}, new Date(u.submittedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })),
                ),
              )),
            ),
          )
        : h('p', { class: 'empty' }, data.project.id === overview.activeProjectId
          ? 'No submissions yet. Show the QR code to the participants.'
          : 'No submissions in this project.'),
    ),
  ];
}

function renderSettings(missing) {
  const inputs = {};
  const used = new Set(data.users.flatMap((u) => u.receipts.map((r) => r.currency)));
  const phone = h('input', { value: overview.settings.phoneUrl || '', placeholder: 'Automatic', oninput: () => dirty.add('settings') });
  const form = h('form', {
    class: 'rates',
    onsubmit: (e) => {
      e.preventDefault();
      const rates = Object.fromEntries(Object.entries(inputs).map(([c, input]) => [c, input.value.trim()]));
      run(async () => {
        await api('PUT', projectUrl('/rates'), { rates });
        await api('PUT', '/api/admin/settings', { phoneUrl: phone.value.trim() });
      }, e.submitter);
    },
  },
    h('p', { class: 'hint' }, 'How much of each currency one euro buys in this project, e.g. 1 EUR = 395.50 HUF.'),
    h('div', { class: 'rate-grid' },
      data.currencies.filter((c) => c !== 'EUR').map((c) => {
        inputs[c] = h('input', { inputmode: 'decimal', value: data.project.rates[c] ?? '', oninput: () => dirty.add('settings') });
        return h('label', { class: `rate ${missing.includes(c) ? 'missing' : ''} ${used.has(c) ? 'used' : ''}` },
          h('span', {}, '1 EUR ='), inputs[c], h('span', {}, c));
      }),
    ),
    h('label', {}, 'Phone address (only if the automatic one is wrong)', phone),
    h('button', { class: 'button primary', type: 'submit' }, 'Save settings'),
  );
  return h('details', { class: 'card', open: missing.length > 0 || dirty.has('settings') },
    h('summary', {}, h('h2', {}, 'Exchange rates and settings')),
    form,
  );
}

// ---------- one participant ----------

function countrySelect(value, list) {
  const options = value && !list.includes(value) ? [...list, value] : list;
  return h('select', {}, h('option', { value: '' }, '—'), options.map((c) => h('option', { value: c, selected: c === value }, c)));
}

function renderUser(user) {
  const details = {};
  const field = (key, input) => {
    details[key] = input;
    input.addEventListener('input', () => dirty.add('details'));
    return input;
  };
  const projectHref = `#p=${encodeURIComponent(data.project.id)}`;

  const detailsForm = h('form', {
    class: 'grid two',
    onsubmit: (e) => {
      e.preventDefault();
      const body = Object.fromEntries(Object.entries(details).map(([k, input]) => [k, input.value]));
      run(() => api('PATCH', projectUrl(`/users/${user.id}`), body), e.submitter);
    },
  },
    h('label', {}, 'First name', field('firstName', h('input', { value: user.firstName, required: true }))),
    h('label', {}, 'Last name', field('lastName', h('input', { value: user.lastName, required: true }))),
    h('label', {}, 'Date of birth', field('dob', h('input', { type: 'date', value: user.dob, required: true }))),
    h('label', {}, 'Email', field('email', h('input', { type: 'email', value: user.email, required: true }))),
    h('label', {}, 'Country', field('country', h('select', {}, config.COUNTRIES.map((c) => h('option', { value: c, selected: c === user.country }, c))))),
    h('label', {}, 'Maximum reimbursement in EUR (empty = no cap)',
      field('capEur', h('input', { inputmode: 'decimal', value: user.capEur ?? '', placeholder: 'No cap' }))),
    h('div', { class: 'form-end span-2' }, h('button', { class: 'button primary', type: 'submit' }, 'Save details')),
  );

  const remove = () => {
    if (!confirm(`Delete ${user.firstName} ${user.lastName} and all their receipt files? This cannot be undone.`)) return;
    run(async () => {
      await api('DELETE', projectUrl(`/users/${user.id}`));
      location.hash = projectHref.slice(1);
    });
  };

  return [
    h('p', {}, h('a', { href: projectHref, class: 'back' }, `← ${data.project.title}`)),
    h('div', { class: 'card-head' },
      h('div', {},
        h('h2', { class: 'title' }, `${user.firstName} ${user.lastName}`),
        h('p', { class: 'muted' }, `Participant no. ${user.number} · submitted ${new Date(user.submittedAt).toLocaleString('en-GB')}`),
      ),
      h('div', { class: 'actions' },
        h('a', { class: 'button primary', href: projectUrl(`/users/${user.id}/form.pdf`) }, 'Form (PDF)'),
        h('button', { class: 'button danger', type: 'button', onclick: remove }, 'Delete participant'),
      ),
    ),
    h('div', { class: 'tiles' },
      tile('Receipts counted', String(user.acceptedCount)),
      tile('Sum of receipts', eur(user.sumEur)),
      user.capEur !== null ? tile('Cap', eur(user.capEur), user.capped ? 'warn' : '') : null,
      tile('Reimbursed', eur(user.totalEur), 'accent'),
      user.missingRates.length ? tile('Missing rates', user.missingRates.join(', '), 'warn') : null,
    ),
    h('section', { class: 'card' }, h('h2', {}, 'Details'), detailsForm),
    h('section', { class: 'card' },
      h('h2', {}, 'Receipts (one row each on the form)'),
      h('ol', { class: 'admin-receipts' }, user.receipts.map((r) => renderReceipt(user, r))),
    ),
  ];
}

function renderReceipt(user, r) {
  const key = `receipt-${r.id}`;
  const base = projectUrl(`/users/${user.id}/receipts/${r.id}/file`);
  const inputs = {};
  const save = h('button', { class: 'button primary', type: 'submit', disabled: true }, 'Save');
  const field = (name, input) => {
    inputs[name] = input;
    input.addEventListener('input', () => {
      dirty.add(key);
      save.disabled = false;
    });
    return input;
  };
  const countries = data.project.routeCountries;
  const isImage = r.file.mime.startsWith('image/') && r.file.mime !== 'image/heic';
  const preview = isImage
    ? h('a', { href: base, target: '_blank', class: 'preview' }, h('img', { src: base, alt: `Receipt ${r.number}`, loading: 'lazy' }))
    : h('a', { href: base, target: '_blank', class: 'preview doc' }, r.file.mime === 'application/pdf' ? 'PDF' : 'HEIC');

  const s = r.submitted;
  const changed = r.editedAt && ['amount', 'currency', 'date', 'transport', 'fromCity', 'fromCountry', 'toCity', 'toCountry'].some((k) => (s[k] ?? '') !== (r[k] ?? ''));
  const place = (k) => [s[`${k}City`], s[`${k}Country`]].filter(Boolean).join(', ');

  return h('li', { class: `admin-receipt ${r.status}` },
    preview,
    h('form', {
      class: 'receipt-form',
      onsubmit: (e) => {
        e.preventDefault();
        const body = Object.fromEntries(Object.entries(inputs).map(([k, input]) => [k, input.value]));
        run(() => api('PATCH', projectUrl(`/users/${user.id}/receipts/${r.id}`), body), save);
      },
    },
      h('div', { class: 'receipt-top' },
        h('strong', {}, `#${r.number} ${r.file.originalName}`),
        h('span', { class: 'muted' }, formatSize(r.file.size)),
        h('a', { href: `${base}?download=1` }, 'Download original'),
      ),
      h('div', { class: 'receipt-fields' },
        h('label', {}, 'From city', field('fromCity', h('input', { value: r.fromCity }))),
        h('label', {}, 'From country', field('fromCountry', countrySelect(r.fromCountry, countries))),
        h('label', {}, 'To city', field('toCity', h('input', { value: r.toCity }))),
        h('label', {}, 'To country', field('toCountry', countrySelect(r.toCountry, countries))),
        h('label', {}, 'Transport', field('transport', h('select', {},
          h('option', { value: '' }, '—'),
          config.TRANSPORT.map((t) => h('option', { value: t, selected: t === r.transport }, t)),
        ))),
        h('label', {}, 'Date', field('date', h('input', { type: 'date', value: r.date || '' }))),
        h('label', {}, 'Amount', field('amount', h('input', { inputmode: 'decimal', value: r.amount.toFixed(2) }))),
        h('label', {}, 'Currency', field('currency', h('select', {}, data.currencies.map((c) => h('option', { value: c, selected: c === r.currency }, c))))),
        h('label', {}, 'Status', field('status', h('select', {},
          h('option', { value: 'accepted', selected: r.status === 'accepted' }, 'Accepted'),
          h('option', { value: 'rejected', selected: r.status === 'rejected' }, 'Rejected'),
        ))),
      ),
      h('div', { class: 'receipt-bottom' },
        h('span', { class: 'converted' },
          r.eur === null ? h('span', { class: 'badge warn' }, `no rate for ${r.currency}`) : eur(r.eur),
          r.currency !== 'EUR' && r.rate ? h('span', { class: 'muted' }, ` at 1 EUR = ${r.rate} ${r.currency}`) : null,
        ),
        changed
          ? h('span', { class: 'muted' }, `Participant entered: ${formatMoney(s.amount)} ${s.currency}${s.date ? `, ${formatDate(s.date)}` : ''}${s.transport ? `, ${s.transport}` : ''}${s.fromCity ? `, ${place('from')} → ${place('to')}` : ''}`)
          : null,
        save,
      ),
    ),
  );
}

// ---------- QR code ----------

document.querySelector('#show-qr').addEventListener('click', () => {
  const list = document.querySelector('#qr-list');
  list.replaceChildren(
    ...(overview.phoneUrls.length
      ? overview.phoneUrls.map((url) =>
          h('figure', {}, h('img', { src: `/api/admin/qr.svg?url=${encodeURIComponent(url)}`, alt: `QR code for ${url}` }), h('figcaption', {}, url)))
      : [h('p', { class: 'warning' }, 'The tablet did not report its network address. Enter it under Settings (see README).')]),
  );
  document.querySelector('#qr-dialog').showModal();
});

window.addEventListener('hashchange', () => {
  window.scrollTo(0, 0);
  if (overview) load().catch((err) => alert(err.message));
});

setInterval(() => {
  const editing = dirty.size > 0 || document.activeElement?.matches('input, select') || ['new', 'edit'].includes(route().page);
  if (config && !document.hidden && !editing && !document.querySelector('#qr-dialog').open) load().catch(() => {});
}, REFRESH_MS);

fetch('/api/config')
  .then((res) => res.json())
  .then((json) => {
    config = json;
    return load();
  })
  .catch((err) => {
    view.replaceChildren(h('p', { class: 'error' }, `Could not load data: ${err.message}`));
  });
