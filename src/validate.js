import { COUNTRIES, CURRENCIES, HOST_COUNTRIES, TRANSPORT } from './config.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ANY_COUNTRY = new Set([...COUNTRIES, ...HOST_COUNTRIES]);

function isRealDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function text(value, max) {
  return typeof value === 'string' ? value.normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function number(value) {
  return typeof value === 'string' ? Number(value.trim().replace(',', '.')) : value;
}

export class ValidationError extends Error {
  constructor(errors) {
    super(Object.values(errors).join(' '));
    this.errors = errors;
    this.status = 400;
  }
}

// Project details entered on the tablet. With `partial`, only fields present are checked.
export function validateProject(input, { partial = false } = {}) {
  const out = {};
  const errors = {};
  const has = (k) => !partial || input[k] !== undefined;

  if (has('title')) {
    out.title = text(input.title, 200).replace(/^["“”]+|["“”]+$/g, '');
    if (!out.title) errors.title = 'Project title is required.';
  }
  if (has('projectNumber')) {
    out.projectNumber = text(input.projectNumber, 100);
    if (!out.projectNumber) errors.projectNumber = 'Project number is required.';
  }
  for (const key of ['startDate', 'endDate']) {
    if (!has(key)) continue;
    out[key] = text(input[key], 10);
    if (!isRealDate(out[key])) errors[key] = `${key === 'startDate' ? 'Start' : 'End'} date is not valid.`;
  }
  if (out.startDate && out.endDate && !errors.startDate && !errors.endDate && out.endDate < out.startDate) {
    errors.endDate = 'The end date is before the start date.';
  }
  if (has('hostCountry')) {
    out.hostCountry = text(input.hostCountry, 60);
    if (!HOST_COUNTRIES.includes(out.hostCountry)) errors.hostCountry = 'Please choose the host country.';
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return out;
}

// Participant details. With `partial`, only the fields present are checked (admin edits).
export function validateDetails(input, { partial = false, allowCap = false } = {}) {
  const out = {};
  const errors = {};
  const has = (k) => !partial || input[k] !== undefined;

  for (const key of ['firstName', 'lastName']) {
    if (!has(key)) continue;
    out[key] = text(input[key], 100);
    if (!out[key]) errors[key] = `${key === 'firstName' ? 'First' : 'Last'} name is required.`;
  }
  if (has('dob')) {
    out.dob = text(input.dob, 10);
    const today = new Date().toISOString().slice(0, 10);
    if (!isRealDate(out.dob) || out.dob < '1900-01-01' || out.dob > today) errors.dob = 'Date of birth is not valid.';
  }
  if (has('email')) {
    out.email = text(input.email, 200).toLowerCase();
    if (!EMAIL.test(out.email)) errors.email = 'Email address is not valid.';
  }
  if (has('country')) {
    out.country = text(input.country, 50);
    if (!COUNTRIES.includes(out.country)) errors.country = 'Please choose a country.';
  }
  if (allowCap && input.capEur !== undefined) {
    const cap = input.capEur === '' || input.capEur === null ? null : number(input.capEur);
    if (cap !== null && (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0)) errors.capEur = 'The cap must be an amount in EUR.';
    else out.capEur = cap === null ? null : Math.round(cap * 100) / 100;
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return out;
}

const ROUTE_LABELS = { fromCity: 'From city', fromCountry: 'From country', toCity: 'To city', toCountry: 'To country' };

// A receipt (one row of the form). Phones must fill everything (`required`);
// the admin can edit fields one by one (`partial`).
export function validateReceipt(input, { partial = false, required = false } = {}) {
  const out = {};
  const errors = {};
  const has = (k) => !partial || input[k] !== undefined;

  if (has('amount')) {
    const amount = number(input.amount);
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) {
      errors.amount = 'Amount must be a number above zero.';
    } else {
      out.amount = Math.round(amount * 100) / 100;
    }
  }
  if (has('currency')) {
    out.currency = text(input.currency, 3).toUpperCase();
    if (!CURRENCIES.includes(out.currency)) errors.currency = 'Unknown currency.';
  }
  if (has('date')) {
    out.date = text(input.date, 10);
    if (out.date ? !isRealDate(out.date) : required) errors.date = 'Travel date is missing or not valid.';
  }
  if (has('transport')) {
    out.transport = text(input.transport, 20).toUpperCase();
    if (out.transport ? !TRANSPORT.includes(out.transport) : required) errors.transport = 'Please choose the means of transport.';
  }
  for (const key of ['fromCity', 'toCity']) {
    if (!has(key)) continue;
    out[key] = text(input[key], 100);
    if (!out[key] && required) errors[key] = `${ROUTE_LABELS[key]} is required.`;
  }
  for (const key of ['fromCountry', 'toCountry']) {
    if (!has(key)) continue;
    out[key] = text(input[key], 60);
    if (out[key] ? !ANY_COUNTRY.has(out[key]) : required) errors[key] = `${ROUTE_LABELS[key]} is required.`;
  }
  if (input.status !== undefined) {
    if (!['accepted', 'rejected'].includes(input.status)) errors.status = 'Unknown status.';
    else out.status = input.status;
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return out;
}

export function validateRates(input) {
  const rates = {};
  const errors = {};
  for (const [code, raw] of Object.entries(input || {})) {
    if (!CURRENCIES.includes(code) || code === 'EUR') continue;
    if (raw === '' || raw === null || raw === undefined) continue;
    const value = number(raw);
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) errors[code] = `Rate for ${code} is not valid.`;
    else rates[code] = value;
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return rates;
}
