// Settings shared by the server and (via /api/config) the phone page.

export const BASE_CURRENCY = 'EUR';

export const COUNTRIES = ['Bulgaria', 'Hungary', 'Poland', 'Romania', 'Spain', 'Turkey', 'Other'];

// Currencies a receipt can be in. Exchange rates for these are entered on the tablet.
export const CURRENCIES = ['EUR', 'BGN', 'HUF', 'PLN', 'RON', 'TRY', 'GBP', 'USD', 'CHF', 'CZK'];

// Languages the phone can read receipts in (Tesseract codes). English is always loaded too.
export const OCR_LANGUAGES = {
  eng: 'English',
  bul: 'Bulgarian',
  hun: 'Hungarian',
  pol: 'Polish',
  ron: 'Romanian',
  spa: 'Spanish',
  tur: 'Turkish',
};

// Starting guesses for a new receipt, based on the participant's country.
export const COUNTRY_DEFAULTS = {
  Bulgaria: { lang: 'bul', currency: 'EUR' },
  Hungary: { lang: 'hun', currency: 'HUF' },
  Poland: { lang: 'pol', currency: 'PLN' },
  Romania: { lang: 'ron', currency: 'RON' },
  Spain: { lang: 'spa', currency: 'EUR' },
  Turkey: { lang: 'tur', currency: 'TRY' },
  Other: { lang: 'eng', currency: 'EUR' },
};

export const LIMITS = {
  maxReceipts: 30,
  maxFileBytes: 25 * 1024 * 1024,
};

export function publicConfig() {
  return { BASE_CURRENCY, COUNTRIES, CURRENCIES, OCR_LANGUAGES, COUNTRY_DEFAULTS, LIMITS };
}
