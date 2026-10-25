import { h, formatMoney, formatSize } from './js/dom.js';
import { parseAmount, parseReceipt } from './js/receipt-parse.js';
import { isPdf, readReceipt } from './js/scan.js';

const $ = (sel) => document.querySelector(sel);
const form = $('#claim');
const list = $('#receipts');
const defaultLang = $('#default-lang');

let config;
const receipts = [];
let nextKey = 0;
let submitted = false;

// crypto.randomUUID() needs HTTPS; the hotspot page is plain HTTP.
function randomId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const submissionId = randomId();

function countryDefaults() {
  return config.COUNTRY_DEFAULTS[form.country.value] || config.COUNTRY_DEFAULTS.Other;
}

function languageOptions(selected) {
  return Object.entries(config.OCR_LANGUAGES).map(([code, name]) => h('option', { value: code, selected: code === selected }, name));
}

// ---------- receipt cards ----------

function addFiles(files) {
  for (const file of files) {
    if (receipts.length >= config.LIMITS.maxReceipts) {
      alert(`You can add at most ${config.LIMITS.maxReceipts} receipts.`);
      break;
    }
    if (file.size > config.LIMITS.maxFileBytes) {
      alert(`${file.name} is larger than ${config.LIMITS.maxFileBytes / 1024 / 1024} MB and cannot be sent.`);
      continue;
    }
    const receipt = {
      key: nextKey++,
      file,
      lang: defaultLang.value,
      status: 'queued',
      progress: 0,
      touched: new Set(),
      scan: null,
    };
    buildCard(receipt);
    receipts.push(receipt);
    list.append(receipt.el.card);
  }
  refreshSummary();
  processQueue();
}

function buildCard(receipt) {
  const el = {};
  const field = (name, input) => {
    input.name = name;
    input.addEventListener('input', () => {
      receipt.touched.add(name);
      el.card.classList.remove('invalid');
      refreshSummary();
    });
    el[name] = input;
    return input;
  };

  function placeFields(title, key) {
    return h('fieldset', { class: 'place' },
      h('legend', {}, title),
      h('div', { class: 'grid two' },
        h('label', {}, 'City', field(`${key}City`, h('input', { maxlength: 100, autocomplete: 'off' }))),
        h('label', {}, 'Country', field(`${key}Country`, h('select', {},
          h('option', { value: '' }, 'Choose…'),
          config.project.routeCountries.map((c) => h('option', { value: c }, c)),
        ))),
      ),
    );
  }

  el.thumb = h('div', { class: 'thumb' }, isPdf(receipt.file) ? 'PDF' : '');
  if (!isPdf(receipt.file)) {
    const img = h('img', { alt: '', src: URL.createObjectURL(receipt.file), onerror: () => img.remove() });
    el.thumb.append(img);
  }
  el.status = h('span', { class: 'status' });
  el.bar = h('progress', { max: 1, value: 0 });
  el.lang = h('select', { 'aria-label': 'Receipt language', onchange: () => rescan(receipt) }, languageOptions(receipt.lang));

  el.card = h('li', { class: 'receipt' },
    h('div', { class: 'receipt-head' },
      el.thumb,
      h('div', { class: 'receipt-title' },
        h('strong', {}, receipt.file.name || 'Photo'),
        h('span', { class: 'muted' }, formatSize(receipt.file.size)),
        el.status,
        el.bar,
      ),
      h('button', { type: 'button', class: 'icon', 'aria-label': 'Remove receipt', onclick: () => removeReceipt(receipt) }, '×'),
    ),
    h('div', { class: 'grid fields' },
      h('label', {}, 'Amount', field('amount', h('input', { inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00' }))),
      h('label', {}, 'Currency', field('currency', h('select', {}, config.CURRENCIES.map((c) => h('option', { value: c }, c))))),
      h('label', {}, 'Travel date', field('date', h('input', { type: 'date' }))),
      h('label', {}, 'Means of transport', field('transport', h('select', {},
        h('option', { value: '' }, 'Choose…'),
        config.TRANSPORT.map((t) => h('option', { value: t }, t)),
      ))),
    ),
    placeFields('From', 'from'),
    placeFields('To', 'to'),
    h('div', { class: 'receipt-foot' },
      h('label', { class: 'inline small' }, 'Language', el.lang),
      h('button', { type: 'button', class: 'link', onclick: () => rescan(receipt) }, 'Read again'),
    ),
  );
  el.currency.value = countryDefaults().currency;
  receipt.el = el;
  updateStatus(receipt);
}

function updateStatus(receipt) {
  const { status, bar } = receipt.el;
  bar.hidden = receipt.status !== 'reading';
  bar.value = receipt.progress;
  receipt.el.card.dataset.state = receipt.status;
  if (receipt.status === 'queued') status.textContent = 'Waiting to be read…';
  else if (receipt.status === 'reading') status.textContent = 'Reading receipt…';
  else if (receipt.status === 'failed') status.textContent = 'Could not read it automatically. Please type the details.';
  else if (receipt.scan?.confidence === 'high') status.textContent = 'Read. Please check the details.';
  else if (receipt.scan?.amount) status.textContent = 'Not sure about the amount. Please check it carefully.';
  else status.textContent = 'No total found. Please type the details.';
}

function applyScan(receipt, result) {
  receipt.scan = { ...result, lang: receipt.lang };
  const { el, touched } = receipt;
  if (!touched.has('amount') && result.amount) el.amount.value = result.amount.toFixed(2);
  if (!touched.has('currency') && result.currency && config.CURRENCIES.includes(result.currency)) el.currency.value = result.currency;
  if (!touched.has('date') && result.date) el.date.value = result.date;
  if (!touched.has('transport') && result.transport) el.transport.value = result.transport;
  for (const key of ['from', 'to']) {
    const city = result[`${key}City`];
    if (!city || touched.has(`${key}City`) || touched.has(`${key}Country`)) continue;
    el[`${key}City`].value = city;
    // Countries outside this project's list are recorded as "Other".
    const country = result[`${key}Country`];
    el[`${key}Country`].value = config.project.routeCountries.includes(country) ? country : 'Other';
  }
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
      updateStatus(receipt);
      try {
        const { text, thumbnail } = await readReceipt(receipt.file, receipt.lang, (p) => {
          receipt.progress = p;
          receipt.el.bar.value = p;
        });
        if (thumbnail && !receipt.el.thumb.querySelector('img')) receipt.el.thumb.replaceChildren(h('img', { alt: '', src: thumbnail }));
        if (!receipts.includes(receipt)) continue; // removed while reading
        applyScan(receipt, parseReceipt(text, { currency: countryDefaults().currency }));
        receipt.status = 'done';
      } catch (err) {
        console.warn('Reading failed', err);
        receipt.status = 'failed';
      }
      updateStatus(receipt);
      refreshSummary();
    }
  } finally {
    busy = false;
  }
}

function rescan(receipt) {
  receipt.lang = receipt.el.lang.value;
  if (receipt.status === 'reading' || receipt.status === 'queued') return;
  // Values typed by the user are kept; everything else can be replaced.
  receipt.status = 'queued';
  updateStatus(receipt);
  processQueue();
}

function removeReceipt(receipt) {
  if (!confirm('Remove this receipt?')) return;
  receipts.splice(receipts.indexOf(receipt), 1);
  receipt.el.card.remove();
  refreshSummary();
}

function refreshSummary() {
  $('#no-receipts').hidden = receipts.length > 0;
  const totals = {};
  for (const r of receipts) {
    const amount = parseAmount(r.el.amount.value.trim());
    if (amount) totals[r.el.currency.value] = (totals[r.el.currency.value] || 0) + amount;
  }
  const parts = Object.entries(totals).map(([c, v]) => `${formatMoney(v)} ${c}`);
  $('#summary').textContent = receipts.length
    ? `${receipts.length} receipt${receipts.length === 1 ? '' : 's'}${parts.length ? `: ${parts.join(' + ')}` : ''}. The organiser converts everything to ${config.BASE_CURRENCY}.`
    : 'Add your receipts above.';
}

// ---------- sending ----------

function showError(message) {
  const box = $('#form-error');
  box.textContent = message;
  box.hidden = !message;
  if (message) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function collect() {
  if (!form.reportValidity()) return null;
  if (!receipts.length) {
    showError('Please add at least one receipt.');
    return null;
  }
  const items = [];
  for (const [i, r] of receipts.entries()) {
    const amount = parseAmount(r.el.amount.value.trim());
    const missing = [
      [!amount || amount <= 0, 'the amount'],
      [!r.el.date.value, 'the travel date'],
      [!r.el.transport.value, 'the means of transport'],
      [!r.el.fromCity.value.trim() || !r.el.fromCountry.value, 'where the journey started (From)'],
      [!r.el.toCity.value.trim() || !r.el.toCountry.value, 'where it ended (To)'],
    ].filter(([bad]) => bad).map(([, what]) => what);
    if (missing.length) {
      r.el.card.classList.add('invalid');
      r.el.card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      showError(`Receipt ${i + 1}: please fill in ${missing.join(', ')}.`);
      return null;
    }
    items.push({
      field: `file${i}`,
      amount,
      currency: r.el.currency.value,
      date: r.el.date.value,
      transport: r.el.transport.value,
      fromCity: r.el.fromCity.value.trim(),
      fromCountry: r.el.fromCountry.value,
      toCity: r.el.toCity.value.trim(),
      toCountry: r.el.toCountry.value,
      scan: r.scan && { amount: r.scan.amount, currency: r.scan.currency, confidence: r.scan.confidence, lang: r.scan.lang },
    });
  }
  return {
    submissionId,
    projectId: config.project.id,
    firstName: form.firstName.value.trim(),
    lastName: form.lastName.value.trim(),
    dob: form.dob.value,
    email: form.email.value.trim(),
    country: form.country.value,
    receipts: items,
  };
}

function send(data) {
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
    xhr.onerror = () => reject(new Error('Could not reach the tablet. Check you are still connected to its Wi-Fi hotspot, then press Send again.'));
    xhr.send(body);
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');
  const data = collect();
  if (!data) return;
  if (!confirm(`Send ${data.receipts.length} receipt${data.receipts.length === 1 ? '' : 's'} now? You cannot change them afterwards.`)) return;

  const button = $('#send');
  button.disabled = true;
  $('#upload').hidden = false;
  try {
    const result = await send(data);
    submitted = true;
    $('#form-view').hidden = true;
    $('#done-view').hidden = false;
    $('#done-text').textContent = `${data.firstName}, your ${result.receiptCount} receipt${result.receiptCount === 1 ? ' was' : 's were'} received. Your participant number is ${result.number}.`;
    window.scrollTo(0, 0);
  } catch (err) {
    showError(err.message);
  } finally {
    button.disabled = false;
    $('#upload').hidden = true;
  }
});

// ---------- start ----------

function eventDates(start, end) {
  const fmt = (iso, opts) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });
  if (start === end) return fmt(start, { day: 'numeric', month: 'long', year: 'numeric' });
  return `${fmt(start, { day: 'numeric', month: 'long' })} – ${fmt(end, { day: 'numeric', month: 'long', year: 'numeric' })}`;
}

async function start() {
  config = await (await fetch('/api/config')).json();
  if (!config.project) {
    $('#form-view').hidden = true;
    $('#closed-view').hidden = false;
    return;
  }
  $('#project-title').textContent = config.project.title;
  $('#project-dates').textContent = eventDates(config.project.startDate, config.project.endDate);
  for (const c of config.COUNTRIES) form.country.append(h('option', { value: c }, c));
  defaultLang.append(...languageOptions('eng'));
  form.dob.max = new Date().toISOString().slice(0, 10);

  form.country.addEventListener('change', () => {
    defaultLang.value = countryDefaults().lang;
  });
  for (const input of [$('#camera-input'), $('#file-input')]) {
    input.addEventListener('change', () => {
      addFiles([...input.files]);
      input.value = '';
    });
  }
  $('#again').addEventListener('click', () => location.reload());
  window.addEventListener('beforeunload', (e) => {
    if (!submitted && (receipts.length || form.firstName.value)) e.preventDefault();
  });
}

start().catch((err) => {
  console.error(err);
  showError('Could not load the page from the tablet. Please reload.');
});
