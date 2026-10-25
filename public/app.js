import { clearDraft, loadDraft, saveDraft } from './js/draft.js';
import { h, formatDate, formatMoney, formatSize } from './js/dom.js';
import { parseAmount, parseReceipt } from './js/receipt-parse.js';
import { isPdf, readReceipt } from './js/scan.js';

const $ = (sel) => document.querySelector(sel);
const details = $('#details');
const list = $('#receipts');

let config;
let step = 1;
let receipts = [];
let nextKey = 0;
let openKey = null; // the receipt whose editor is open
let submitted = false;

// crypto.randomUUID() needs HTTPS; the page is served over plain HTTP.
function randomId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
let submissionId = randomId();

const FIELDS = ['amount', 'currency', 'date', 'transport', 'fromCity', 'fromCountry', 'toCity', 'toCountry'];
const REQUIRED = [
  ['amount', 'amount'],
  ['date', 'date'],
  ['transport', 'transport'],
  ['fromCity', 'From city'],
  ['fromCountry', 'From country'],
  ['toCity', 'To city'],
  ['toCountry', 'To country'],
];

function countryDefaults() {
  return config.COUNTRY_DEFAULTS[details.country.value] || config.COUNTRY_DEFAULTS.Other;
}

// ---------- steps ----------

function showStep(n, { push = true } = {}) {
  step = n;
  document.querySelectorAll('.step').forEach((el) => (el.hidden = Number(el.dataset.step) !== n));
  document.querySelectorAll('.stepper li').forEach((li) => {
    const s = Number(li.dataset.step);
    li.classList.toggle('current', s === n);
    li.classList.toggle('complete', s < n);
  });
  $('#back').hidden = n === 1;
  $('#next').textContent = n === 1 ? 'Next: receipts' : n === 2 ? 'Next: check and send' : 'Send';
  if (n === 3) renderReview();
  showError('');
  window.scrollTo(0, 0);
  // Lets the phone's back gesture go to the previous step instead of leaving.
  if (push) history.pushState({ step: n }, '');
  scheduleSave();
}

window.addEventListener('popstate', (e) => {
  if (!submitted && e.state?.step) showStep(e.state.step, { push: false });
});

$('#back').addEventListener('click', () => history.back());
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => showStep(Number(b.dataset.goto))));

$('#next').addEventListener('click', () => {
  if (step === 1) {
    if (details.reportValidity()) showStep(2);
  } else if (step === 2) {
    if (!receipts.length) {
      toast('Add at least one ticket or receipt first.');
      return;
    }
    const incomplete = receipts.find((r) => missingFields(r).length);
    if (incomplete) {
      openReceipt(incomplete.key);
      toast(`Receipt ${receipts.indexOf(incomplete) + 1} still needs: ${missingFields(incomplete).join(', ')}.`);
      return;
    }
    showStep(3);
  } else {
    send();
  }
});

// ---------- receipts ----------

function addFiles(files, saved = []) {
  for (const [i, file] of [...files].entries()) {
    if (receipts.length >= config.LIMITS.maxReceipts) {
      alert(`You can add at most ${config.LIMITS.maxReceipts} receipts.`);
      break;
    }
    if (file.size > config.LIMITS.maxFileBytes) {
      alert(`${file.name} is larger than ${config.LIMITS.maxFileBytes / 1024 / 1024} MB and cannot be sent.`);
      continue;
    }
    const restore = saved[i];
    const receipt = {
      key: nextKey++,
      file,
      lang: restore?.lang || 'auto',
      status: restore && ['done', 'failed'].includes(restore.status) ? restore.status : 'queued',
      progress: 0,
      touched: new Set(restore?.touched || []),
      scan: restore?.scan || null,
      thumbnail: restore?.thumbnail || null,
    };
    buildReceipt(receipt);
    if (restore) for (const f of FIELDS) receipt.el[f].value = restore.values[f] ?? '';
    receipts.push(receipt);
    list.append(receipt.el.item);
    updateReceipt(receipt);
  }
  refreshList();
  processQueue();
  scheduleSave();
}

function buildReceipt(receipt) {
  const el = {};
  const field = (name, input) => {
    input.name = name;
    input.addEventListener('input', () => {
      receipt.touched.add(name);
      updateReceipt(receipt);
      scheduleSave();
    });
    el[name] = input;
    return input;
  };
  const countrySelect = () =>
    h('select', {}, h('option', { value: '' }, 'Choose…'), config.project.routeCountries.map((c) => h('option', { value: c }, c)));
  const place = (label, key) =>
    h('fieldset', { class: 'place' },
      h('legend', {}, label),
      h('div', { class: 'pair' },
        h('label', {}, 'City', field(`${key}City`, h('input', { maxlength: 100, autocomplete: 'off', placeholder: 'City' }))),
        h('label', {}, 'Country', field(`${key}Country`, countrySelect())),
      ),
    );
  const swap = () => {
    for (const part of ['City', 'Country']) {
      [el[`from${part}`].value, el[`to${part}`].value] = [el[`to${part}`].value, el[`from${part}`].value];
      receipt.touched.add(`from${part}`).add(`to${part}`);
    }
    updateReceipt(receipt);
    scheduleSave();
  };

  el.thumb = h('span', { class: 'thumb' });
  el.title = h('strong', { class: 'row-title' });
  el.subtitle = h('span', { class: 'row-sub' });
  el.chip = h('span', { class: 'chip' });
  el.row = h('button', { type: 'button', class: 'receipt-row', 'aria-expanded': 'false', onclick: () => openReceipt(openKey === receipt.key ? null : receipt.key) },
    h('span', { class: 'row-num' }),
    el.thumb,
    h('span', { class: 'row-text' }, el.title, el.subtitle),
    el.chip,
  );

  el.status = h('p', { class: 'reading' });
  el.bar = h('progress', { max: 1, value: 0 });
  el.lang = h('select', { 'aria-label': 'Language of the receipt' },
    h('option', { value: 'auto' }, 'Automatic'),
    Object.entries(config.OCR_LANGUAGES).map(([code, name]) => h('option', { value: code, selected: code === receipt.lang }, name)));

  el.editor = h('div', { class: 'editor', hidden: true },
    h('div', { class: 'reading-box' }, el.status, el.bar),
    h('div', { class: 'pair' },
      h('label', {}, 'Amount paid', field('amount', h('input', { inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00' }))),
      h('label', {}, 'Currency', field('currency', h('select', {}, config.CURRENCIES.map((c) => h('option', { value: c }, c))))),
    ),
    h('div', { class: 'pair' },
      h('label', {}, 'Travel date', field('date', h('input', { type: 'date' }))),
      h('label', {}, 'Transport', field('transport', h('select', {},
        h('option', { value: '' }, 'Choose…'),
        config.TRANSPORT.map((t) => h('option', { value: t }, t[0] + t.slice(1).toLowerCase())),
      ))),
    ),
    place('From', 'from'),
    h('div', { class: 'swap-row' }, h('button', { type: 'button', class: 'link', onclick: swap }, '⇅ Swap From and To')),
    place('To', 'to'),
    h('details', { class: 'reread' },
      h('summary', {}, 'Details read wrong?'),
      h('p', { class: 'hint small' }, 'Pick the language the receipt is written in and read it again. Values you typed yourself are kept.'),
      h('div', { class: 'pair' }, el.lang, h('button', { type: 'button', class: 'button', onclick: () => rescan(receipt) }, 'Read again')),
    ),
    h('div', { class: 'editor-foot' },
      h('button', { type: 'button', class: 'link danger', onclick: () => removeReceipt(receipt) }, 'Remove'),
      h('button', { type: 'button', class: 'button primary', onclick: () => finishEditing(receipt) }, 'Done'),
    ),
  );
  el.item = h('li', { class: 'receipt' }, el.row, el.editor);
  receipt.el = el;
  el.currency.value = countryDefaults().currency;
  setThumb(receipt);
}

function setThumb(receipt) {
  const { thumb } = receipt.el;
  const src = receipt.thumbnail || (isPdf(receipt.file) ? null : URL.createObjectURL(receipt.file));
  thumb.replaceChildren(src ? h('img', { alt: '', src, onerror: (e) => e.target.replaceWith(isPdf(receipt.file) ? 'PDF' : 'IMG') }) : 'PDF');
}

function value(receipt, name) {
  return receipt.el[name].value.trim();
}

function missingFields(receipt) {
  return REQUIRED.filter(([name]) => (name === 'amount' ? !(parseAmount(value(receipt, name)) > 0) : !value(receipt, name))).map(([, label]) => label);
}

function receiptState(receipt) {
  if (receipt.status === 'queued' || receipt.status === 'reading') return 'reading';
  return missingFields(receipt).length ? 'incomplete' : 'ready';
}

function updateReceipt(receipt) {
  const el = receipt.el;
  const n = receipts.indexOf(receipt) + 1 || receipts.length + 1;
  const state = receiptState(receipt);
  el.item.dataset.state = state;
  el.row.querySelector('.row-num').textContent = String(n);

  const from = value(receipt, 'fromCity');
  const to = value(receipt, 'toCity');
  el.title.textContent = from || to ? `${from || '?'} → ${to || '?'}` : receipt.file.name || `Receipt ${n}`;
  const amount = parseAmount(value(receipt, 'amount'));
  const transport = el.transport.value;
  el.subtitle.textContent = [
    transport && transport[0] + transport.slice(1).toLowerCase(),
    el.date.value && formatDate(el.date.value),
    amount && `${formatMoney(amount)} ${el.currency.value}`,
  ].filter(Boolean).join(' · ') || formatSize(receipt.file.size);
  el.chip.textContent = state === 'reading' ? 'Reading…' : state === 'ready' ? '✓ Ready' : 'Needs details';
  el.chip.className = `chip ${state}`;

  el.bar.hidden = state !== 'reading';
  el.bar.value = receipt.progress;
  const missing = missingFields(receipt);
  el.status.textContent =
    receipt.status === 'queued' ? 'Waiting to be read…'
    : receipt.status === 'reading' ? 'Reading the receipt… you can already fill in details.'
    : receipt.status === 'failed' ? 'We could not read this file. Please type the details.'
    : missing.length ? `Please add: ${missing.join(', ')}.`
    : 'All set. Please check the values are correct.';
  el.status.className = `reading ${state}`;
}

function refreshList() {
  receipts.forEach(updateReceipt);
  const has = receipts.length > 0;
  $('#add-more').hidden = !has;
  const summary = $('#receipt-summary');
  summary.hidden = !has;
  if (has) {
    const counts = { ready: 0, incomplete: 0, reading: 0 };
    receipts.forEach((r) => (counts[receiptState(r)] += 1));
    summary.replaceChildren(
      ...[
        h('strong', {}, `${receipts.length} receipt${receipts.length === 1 ? '' : 's'}`),
        counts.ready && h('span', { class: 'chip ready' }, `${counts.ready} ready`),
        counts.incomplete && h('span', { class: 'chip incomplete' }, `${counts.incomplete} need details`),
        counts.reading && h('span', { class: 'chip reading' }, `${counts.reading} reading`),
      ].filter(Boolean),
    );
  }
}

function openReceipt(key) {
  openKey = key;
  for (const r of receipts) {
    const open = r.key === key;
    r.el.editor.hidden = !open;
    r.el.row.setAttribute('aria-expanded', String(open));
    r.el.item.classList.toggle('open', open);
  }
  const receipt = receipts.find((r) => r.key === key);
  if (receipt) receipt.el.item.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function finishEditing(receipt) {
  // Move straight on to the next receipt that still needs something.
  const next = receipts.find((r) => r !== receipt && receiptState(r) === 'incomplete');
  openReceipt(next ? next.key : null);
  if (!next) receipt.el.item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function applyScan(receipt, result) {
  receipt.scan = { amount: result.amount, currency: result.currency, confidence: result.confidence, lang: receipt.lang };
  const { el, touched } = receipt;
  const set = (name, v) => {
    if (v && !touched.has(name)) el[name].value = v;
  };
  set('amount', result.amount && result.amount.toFixed(2));
  if (config.CURRENCIES.includes(result.currency)) set('currency', result.currency);
  set('date', result.date);
  set('transport', result.transport);
  for (const key of ['from', 'to']) {
    if (!result[`${key}City`] || touched.has(`${key}City`) || touched.has(`${key}Country`)) continue;
    el[`${key}City`].value = result[`${key}City`];
    // Countries outside this project's list are recorded as "Other".
    const country = result[`${key}Country`];
    el[`${key}Country`].value = config.project.routeCountries.includes(country) ? country : 'Other';
  }
}

// "Automatic" reads with the participant's language and the host country's language.
function ocrLanguages(receipt) {
  if (receipt.lang !== 'auto') return [receipt.lang];
  return [countryDefaults().lang, config.project.hostLang].filter(Boolean);
}

let busy = false;
async function processQueue() {
  if (busy) return;
  busy = true;
  try {
    let receipt;
    while ((receipt = receipts.find((r) => r.status === 'queued'))) {
      receipt.status = 'reading';
      receipt.progress = 0;
      refreshList();
      try {
        const { text, thumbnail } = await readReceipt(receipt.file, ocrLanguages(receipt), (p) => {
          receipt.progress = p;
          receipt.el.bar.value = p;
        });
        if (thumbnail && !receipt.thumbnail) {
          receipt.thumbnail = thumbnail;
          setThumb(receipt);
        }
        if (!receipts.includes(receipt)) continue; // removed while reading
        applyScan(receipt, parseReceipt(text, { currency: countryDefaults().currency }));
        receipt.status = 'done';
      } catch (err) {
        console.warn('Reading failed', err);
        receipt.status = 'failed';
      }
      refreshList();
      scheduleSave();
    }
  } finally {
    busy = false;
  }
}

function rescan(receipt) {
  receipt.lang = receipt.el.lang.value;
  if (receipt.status === 'reading' || receipt.status === 'queued') return;
  receipt.status = 'queued';
  refreshList();
  processQueue();
}

function removeReceipt(receipt) {
  if (!confirm('Remove this receipt?')) return;
  receipts = receipts.filter((r) => r !== receipt);
  receipt.el.item.remove();
  if (openKey === receipt.key) openKey = null;
  refreshList();
  scheduleSave();
}

// ---------- review and send ----------

function renderReview() {
  const d = details;
  $('#review-details').replaceChildren(
    ...[
      ['Name', `${d.firstName.value} ${d.lastName.value}`],
      ['Date of birth', formatDate(d.dob.value)],
      ['Email', d.email.value],
      ['Country', d.country.value],
    ].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]),
  );
  $('#review-title').textContent = `Journeys (${receipts.length})`;
  const totals = {};
  $('#review-receipts').replaceChildren(
    ...receipts.map((r) => {
      const amount = parseAmount(value(r, 'amount'));
      totals[r.el.currency.value] = (totals[r.el.currency.value] || 0) + amount;
      return h('li', {},
        h('div', {},
          h('strong', {}, `${value(r, 'fromCity')} → ${value(r, 'toCity')}`),
          h('span', { class: 'muted' }, `${r.el.transport.value[0] + r.el.transport.value.slice(1).toLowerCase()} · ${formatDate(r.el.date.value)}`),
        ),
        h('strong', { class: 'amount' }, `${formatMoney(amount)} ${r.el.currency.value}`),
      );
    }),
  );
  $('#review-totals').textContent = `Total: ${Object.entries(totals).map(([c, v]) => `${formatMoney(v)} ${c}`).join(' + ')}`;
}

function showError(message) {
  const box = $('#form-error');
  box.textContent = message;
  box.hidden = !message;
  if (message) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

let toastTimer;
function toast(message) {
  let el = $('#toast');
  if (!el) document.body.append((el = h('div', { id: 'toast', class: 'toast', role: 'status' })));
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

function payload() {
  return {
    submissionId,
    projectId: config.project.id,
    firstName: details.firstName.value.trim(),
    lastName: details.lastName.value.trim(),
    dob: details.dob.value,
    email: details.email.value.trim(),
    country: details.country.value,
    receipts: receipts.map((r, i) => ({
      field: `file${i}`,
      ...Object.fromEntries(FIELDS.map((f) => [f, value(r, f)])),
      amount: parseAmount(value(r, 'amount')),
      scan: r.scan,
    })),
  };
}

function upload(data) {
  const body = new FormData();
  body.append('data', JSON.stringify(data));
  receipts.forEach((r, i) => body.append(`file${i}`, r.file, r.file.name || `receipt-${i + 1}`));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/submissions');
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      $('#upload-bar').value = e.loaded / e.total;
      $('#upload-text').textContent = `Sending… ${Math.round((e.loaded / e.total) * 100)}%`;
    };
    xhr.onload = () => {
      let json = {};
      try {
        json = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(json);
      else reject(new Error(json.error || `The tablet answered with an error (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error('Could not reach the tablet. Check you are still connected to the same Wi-Fi, then press Send again.'));
    xhr.send(body);
  });
}

async function send() {
  showError('');
  if (!confirm(`Send ${receipts.length} receipt${receipts.length === 1 ? '' : 's'} now? You cannot change them afterwards.`)) return;
  const button = $('#next');
  button.disabled = true;
  $('#back').disabled = true;
  $('#upload').hidden = false;
  try {
    const result = await upload(payload());
    submitted = true;
    await clearDraft();
    $('#form-view').hidden = true;
    $('#done-view').hidden = false;
    $('#done-text').textContent = `${details.firstName.value.trim()}, your ${result.receiptCount} receipt${result.receiptCount === 1 ? ' was' : 's were'} received. Your participant number is ${result.number}.`;
    window.scrollTo(0, 0);
  } catch (err) {
    showError(err.message);
  } finally {
    button.disabled = false;
    $('#back').disabled = false;
    $('#upload').hidden = true;
  }
}

// ---------- draft ----------

let saveTimer;
function scheduleSave() {
  if (!config?.project || submitted) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

// Also called when the page goes to the background (e.g. the camera opens),
// since the phone may discard the page from there.
function saveNow() {
  if (!config?.project || submitted) return;
  clearTimeout(saveTimer);
  saveDraft({
    projectId: config.project.id,
    submissionId,
    step,
    details: Object.fromEntries(['firstName', 'lastName', 'dob', 'email', 'country'].map((k) => [k, details[k].value])),
    receipts: receipts.map((r) => ({
      file: r.file,
      lang: r.lang,
      status: r.status,
      scan: r.scan,
      thumbnail: r.thumbnail,
      touched: [...r.touched],
      values: Object.fromEntries(FIELDS.map((f) => [f, r.el[f].value])),
    })),
  });
}
document.addEventListener('visibilitychange', () => document.hidden && saveNow());

async function restoreDraft() {
  const draft = await loadDraft(config.project.id);
  if (!draft) return;
  submissionId = draft.submissionId;
  for (const [k, v] of Object.entries(draft.details)) details[k].value = v;
  if (draft.receipts.length) addFiles(draft.receipts.map((r) => r.file), draft.receipts);
  $('#restored').hidden = false;
  return draft.step;
}

// ---------- start ----------

function eventDates(start, end) {
  const fmt = (iso, opts) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });
  if (start === end) return fmt(start, { day: 'numeric', month: 'long', year: 'numeric' });
  return `${fmt(start, { day: 'numeric', month: 'long' })} – ${fmt(end, { day: 'numeric', month: 'long', year: 'numeric' })}`;
}

async function start() {
  config = await (await fetch('/api/config')).json();
  if (!config.project) {
    $('#closed-view').hidden = false;
    return;
  }
  $('#form-view').hidden = false;
  $('#project-title').textContent = config.project.title;
  $('#project-dates').textContent = eventDates(config.project.startDate, config.project.endDate);
  document.title = config.project.title;
  for (const c of config.COUNTRIES) details.country.append(h('option', { value: c }, c));
  details.dob.max = new Date().toISOString().slice(0, 10);
  details.addEventListener('input', scheduleSave);

  for (const input of [$('#camera-input'), $('#file-input')]) {
    input.addEventListener('change', () => {
      const count = input.files.length;
      addFiles(input.files);
      input.value = '';
      if (count) toast(`${count} receipt${count === 1 ? '' : 's'} added. Add more, or tap one to check it.`);
    });
  }
  $('#start-over').addEventListener('click', async () => {
    if (!confirm('Clear this form and start again?')) return;
    await clearDraft();
    location.reload();
  });
  $('#again').addEventListener('click', () => location.reload());
  window.addEventListener('beforeunload', (e) => {
    if (!submitted && (receipts.length || details.firstName.value)) e.preventDefault();
  });

  const savedStep = await restoreDraft();
  history.replaceState({ step: 1 }, '');
  showStep(1, { push: false });
  if (savedStep > 1 && details.checkValidity()) showStep(savedStep === 3 ? 2 : savedStep);
}

start().catch((err) => {
  console.error(err);
  document.body.append(h('p', { class: 'error page' }, 'Could not load the page from the tablet. Please reload.'));
});
