import { h, formatDate, formatMoney, formatSize } from '/js/dom.js';

const view = document.querySelector('#view');
const REFRESH_MS = 8000;

let config = null;
let state = null;
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

function currentUserId() {
  const m = /^#user=(.+)$/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

async function load() {
  state = await api('GET', '/api/admin/state');
  dirty.clear();
  render();
}

async function run(action, button) {
  if (button) button.disabled = true;
  try {
    state = await action();
    dirty.clear();
    render();
  } catch (err) {
    alert(err.message);
  } finally {
    if (button) button.disabled = false;
  }
}

function eur(value) {
  return `${formatMoney(value)} EUR`;
}

function render() {
  const url = state.phoneUrls[0];
  document.querySelector('#phone-url').textContent = url || 'address unknown – see Settings';
  const scroll = window.scrollY;
  const id = currentUserId();
  const user = id && state.users.find((u) => u.id === id);
  if (id && !user) {
    location.hash = '';
    return;
  }
  view.replaceChildren(...(user ? renderUser(user) : renderList()));
  window.scrollTo(0, scroll);
}

// ---------- overview ----------

function tile(label, value, extra) {
  return h('div', { class: `tile ${extra || ''}` }, h('span', { class: 'muted' }, label), h('strong', {}, value));
}

function renderList() {
  const { totals } = state;
  const missing = totals.missingRates;
  const term = search.toLowerCase();
  const users = state.users.filter((u) => !term || `${u.firstName} ${u.lastName} ${u.email} ${u.country}`.toLowerCase().includes(term));

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
    h('div', { class: 'tiles' },
      tile('Participants', String(totals.userCount)),
      tile('Receipts counted', String(totals.receiptCount)),
      tile('Group total', eur(totals.totalEur), 'accent'),
      missing.length ? tile('Missing rates', missing.join(', '), 'warn') : tile('Exchange rates', 'All set'),
    ),
    h('section', { class: 'card' },
      h('h2', {}, 'Exports'),
      h('div', { class: 'actions' },
        h('a', { class: 'button primary', href: '/api/admin/export/documents.pdf' }, 'All documents (one PDF)'),
        h('a', { class: 'button', href: '/api/admin/export/summary.xlsx' }, 'Excel summary'),
        h('a', { class: 'button', href: '/api/admin/export/archive.zip' }, 'Everything (ZIP)'),
      ),
      missing.length ? h('p', { class: 'warning' }, `Receipts in ${missing.join(', ')} are left out of totals until you set their exchange rate.`) : null,
    ),
    renderSettings(missing),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Participants'), searchBox),
      state.users.length
        ? h('div', { class: 'table-wrap' },
            h('table', { class: 'users' },
              h('thead', {}, h('tr', {}, ['No.', 'Name', 'Country', 'Receipts', 'Total', 'Submitted'].map((t) => h('th', {}, t)))),
              h('tbody', {}, users.map((u) =>
                h('tr', { onclick: () => (location.hash = `user=${encodeURIComponent(u.id)}`) },
                  h('td', {}, String(u.number)),
                  h('td', {}, h('a', { href: `#user=${encodeURIComponent(u.id)}` }, `${u.lastName}, ${u.firstName}`)),
                  h('td', {}, u.country),
                  h('td', {}, `${u.acceptedCount}${u.rejectedCount ? ` (+${u.rejectedCount} rejected)` : ''}`),
                  h('td', { class: 'num' }, eur(u.totalEur), u.missingRates.length ? h('span', { class: 'badge warn' }, `no rate: ${u.missingRates.join(', ')}`) : null),
                  h('td', {}, new Date(u.submittedAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })),
                ),
              )),
            ),
          )
        : h('p', { class: 'empty' }, 'No submissions yet. Show the QR code to the participants.'),
    ),
  ];
}

function renderSettings(missing) {
  const inputs = {};
  const used = new Set(state.users.flatMap((u) => u.receipts.map((r) => r.currency)));
  const phone = h('input', { value: state.settings.phoneUrl || '', placeholder: 'Automatic', oninput: () => dirty.add('settings') });
  const form = h('form', {
    class: 'rates',
    onsubmit: (e) => {
      e.preventDefault();
      const rates = Object.fromEntries(Object.entries(inputs).map(([c, input]) => [c, input.value.trim()]));
      run(() => api('PUT', '/api/admin/settings', { rates, phoneUrl: phone.value.trim() }), e.submitter);
    },
  },
    h('p', { class: 'hint' }, 'How much of each currency one euro buys, e.g. 1 EUR = 395.50 HUF. Used for every receipt.'),
    h('div', { class: 'rate-grid' },
      state.currencies.filter((c) => c !== 'EUR').map((c) => {
        inputs[c] = h('input', { inputmode: 'decimal', value: state.settings.rates[c] ?? '', oninput: () => dirty.add('settings') });
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

function renderUser(user) {
  const details = {};
  const field = (key, input) => {
    details[key] = input;
    input.addEventListener('input', () => dirty.add('details'));
    return input;
  };

  const detailsForm = h('form', {
    class: 'grid two',
    onsubmit: (e) => {
      e.preventDefault();
      const body = Object.fromEntries(Object.entries(details).map(([k, input]) => [k, input.value]));
      run(() => api('PATCH', `/api/admin/users/${user.id}`, body), e.submitter);
    },
  },
    h('label', {}, 'First name', field('firstName', h('input', { value: user.firstName, required: true }))),
    h('label', {}, 'Last name', field('lastName', h('input', { value: user.lastName, required: true }))),
    h('label', {}, 'Date of birth', field('dob', h('input', { type: 'date', value: user.dob, required: true }))),
    h('label', {}, 'Email', field('email', h('input', { type: 'email', value: user.email, required: true }))),
    h('label', {}, 'Country', field('country', h('select', {}, config.COUNTRIES.map((c) => h('option', { value: c, selected: c === user.country }, c))))),
    h('div', { class: 'form-end' }, h('button', { class: 'button primary', type: 'submit' }, 'Save details')),
  );

  const remove = () => {
    if (!confirm(`Delete ${user.firstName} ${user.lastName} and all their receipt files? This cannot be undone.`)) return;
    run(async () => {
      const next = await api('DELETE', `/api/admin/users/${user.id}`);
      location.hash = '';
      return next;
    });
  };

  return [
    h('p', {}, h('a', { href: '#', class: 'back' }, '← All participants')),
    h('div', { class: 'card-head' },
      h('div', {},
        h('h2', { class: 'title' }, `${user.firstName} ${user.lastName}`),
        h('p', { class: 'muted' }, `Participant no. ${user.number} · submitted ${new Date(user.submittedAt).toLocaleString('en-GB')}`),
      ),
      h('div', { class: 'actions' },
        h('a', { class: 'button primary', href: `/api/admin/users/${user.id}/document.pdf` }, 'Document (PDF)'),
        h('button', { class: 'button danger', type: 'button', onclick: remove }, 'Delete participant'),
      ),
    ),
    h('div', { class: 'tiles' },
      tile('Receipts counted', String(user.acceptedCount)),
      tile('Rejected', String(user.rejectedCount)),
      tile('Total', eur(user.totalEur), 'accent'),
      user.missingRates.length ? tile('Missing rates', user.missingRates.join(', '), 'warn') : null,
    ),
    h('section', { class: 'card' }, h('h2', {}, 'Details'), detailsForm),
    h('section', { class: 'card' },
      h('h2', {}, 'Receipts'),
      h('ol', { class: 'admin-receipts' }, user.receipts.map((r) => renderReceipt(user, r))),
    ),
  ];
}

function renderReceipt(user, r) {
  const key = `receipt-${r.id}`;
  const base = `/api/admin/users/${user.id}/receipts/${r.id}/file`;
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
  const isImage = r.file.mime.startsWith('image/') && r.file.mime !== 'image/heic';
  const preview = isImage
    ? h('a', { href: base, target: '_blank', class: 'preview' }, h('img', { src: base, alt: `Receipt ${r.number}`, loading: 'lazy' }))
    : h('a', { href: base, target: '_blank', class: 'preview doc' }, r.file.mime === 'application/pdf' ? 'PDF' : 'HEIC');

  const s = r.submitted;
  const changed = r.editedAt && (s.amount !== r.amount || s.currency !== r.currency || s.date !== r.date || s.vendor !== r.vendor);

  return h('li', { class: `admin-receipt ${r.status}` },
    preview,
    h('form', {
      class: 'receipt-form',
      onsubmit: (e) => {
        e.preventDefault();
        const body = Object.fromEntries(Object.entries(inputs).map(([k, input]) => [k, input.value]));
        run(() => api('PATCH', `/api/admin/users/${user.id}/receipts/${r.id}`, body), save);
      },
    },
      h('div', { class: 'receipt-top' },
        h('strong', {}, `#${r.number} ${r.file.originalName}`),
        h('span', { class: 'muted' }, formatSize(r.file.size)),
        h('a', { href: `${base}?download=1` }, 'Download original'),
      ),
      h('div', { class: 'receipt-fields' },
        h('label', {}, 'Amount', field('amount', h('input', { inputmode: 'decimal', value: r.amount.toFixed(2) }))),
        h('label', {}, 'Currency', field('currency', h('select', {}, state.currencies.map((c) => h('option', { value: c, selected: c === r.currency }, c))))),
        h('label', {}, 'Date', field('date', h('input', { type: 'date', value: r.date || '' }))),
        h('label', { class: 'vendor' }, 'Vendor', field('vendor', h('input', { value: r.vendor || '' }))),
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
        changed ? h('span', { class: 'muted' }, `Participant entered ${formatMoney(s.amount)} ${s.currency}${s.date ? `, ${formatDate(s.date)}` : ''}${s.vendor ? `, ${s.vendor}` : ''}`) : null,
        save,
      ),
    ),
  );
}

// ---------- QR code ----------

document.querySelector('#show-qr').addEventListener('click', () => {
  const list = document.querySelector('#qr-list');
  list.replaceChildren(
    ...(state.phoneUrls.length
      ? state.phoneUrls.map((url) =>
          h('figure', {}, h('img', { src: `/api/admin/qr.svg?url=${encodeURIComponent(url)}`, alt: `QR code for ${url}` }), h('figcaption', {}, url)))
      : [h('p', { class: 'warning' }, 'The tablet did not report its hotspot address. Enter it under Settings (see README).')]),
  );
  document.querySelector('#qr-dialog').showModal();
});

window.addEventListener('hashchange', () => {
  window.scrollTo(0, 0);
  if (state) render();
});

setInterval(() => {
  const editing = dirty.size > 0 || document.activeElement?.matches('input, select');
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
