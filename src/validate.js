import { COUNTRIES, CURRENCIES } from './config.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function text(value, max) {
  return typeof value === 'string' ? value.normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

export class ValidationError extends Error {
  constructor(errors) {
    super(Object.values(errors).join(' '));
    this.errors = errors;
    this.status = 400;
  }
}

// Participant details. With `partial`, only the fields present are checked (admin edits).
export function validateDetails(input, { partial = false } = {}) {
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
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return out;
}

export function validateReceipt(input, { partial = false } = {}) {
  const out = {};
  const errors = {};
  const has = (k) => !partial || input[k] !== undefined;

  if (has('amount')) {
    const amount = typeof input.amount === 'string' ? Number(input.amount.replace(',', '.')) : input.amount;
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
    if (out.date && !isRealDate(out.date)) errors.date = 'Receipt date is not valid.';
  }
  if (has('vendor')) out.vendor = text(input.vendor, 200);
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
    const value = typeof raw === 'string' ? Number(raw.replace(',', '.')) : raw;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) errors[code] = `Rate for ${code} is not valid.`;
    else rates[code] = value;
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return rates;
}
