// Settings shared by the server and (via /api/config) the phone page.

export const BASE_CURRENCY = 'EUR';

// PIN for the admin view. Can be changed when starting: ADMIN_PIN=123456 npm start
export const ADMIN_PIN = process.env.ADMIN_PIN || '080900';

// Countries participants come from.
export const COUNTRIES = ['Bulgaria', 'Hungary', 'Poland', 'Romania', 'Spain', 'Turkey', 'Other'];

// Countries an event can be hosted in (chosen per project on the tablet).
export const HOST_COUNTRIES = [
  'Albania', 'Austria', 'Belgium', 'Bosnia and Herzegovina', 'Bulgaria', 'Croatia', 'Cyprus', 'Czechia',
  'Denmark', 'Estonia', 'Finland', 'France', 'Germany', 'Greece', 'Hungary', 'Iceland', 'Ireland', 'Italy',
  'Kosovo', 'Latvia', 'Liechtenstein', 'Lithuania', 'Luxembourg', 'Malta', 'Moldova', 'Montenegro',
  'Netherlands', 'North Macedonia', 'Norway', 'Poland', 'Portugal', 'Romania', 'Serbia', 'Slovakia',
  'Slovenia', 'Spain', 'Sweden', 'Switzerland', 'Turkey', 'Ukraine', 'United Kingdom',
];

// Countries offered for the From / To of a journey: participant countries plus the host.
export function routeCountries(hostCountry) {
  const list = COUNTRIES.filter((c) => c !== 'Other');
  if (hostCountry && !list.includes(hostCountry)) list.push(hostCountry);
  return [...list.sort(), 'Other'];
}

export const TRANSPORT = ['PLANE', 'CARPOOLING', 'BUS', 'TRAIN'];

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

export function publicConfig(project) {
  return {
    BASE_CURRENCY,
    COUNTRIES,
    HOST_COUNTRIES,
    TRANSPORT,
    CURRENCIES,
    OCR_LANGUAGES,
    COUNTRY_DEFAULTS,
    LIMITS,
    project: project && {
      id: project.id,
      title: project.title,
      startDate: project.startDate,
      endDate: project.endDate,
      hostCountry: project.hostCountry,
      routeCountries: routeCountries(project.hostCountry),
      hostLang: COUNTRY_DEFAULTS[project.hostCountry]?.lang || null,
    },
  };
}
