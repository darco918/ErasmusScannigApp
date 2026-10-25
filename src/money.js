import { BASE_CURRENCY } from './config.js';

export function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// Rates are stored as "1 EUR = rate units of the currency", as banks quote them.
export function rateFor(currency, rates) {
  if (currency === BASE_CURRENCY) return 1;
  const rate = rates[currency];
  return typeof rate === 'number' && rate > 0 ? rate : null;
}

// Each receipt is converted and rounded to cents on its own, so the totals
// match what someone re-adding the printed lines would get.
export function receiptInEur(receipt, rates) {
  const rate = rateFor(receipt.currency, rates);
  return { rate, eur: rate === null ? null : round2(receipt.amount / rate) };
}

export function userSummary(user, rates) {
  let totalEur = 0;
  let accepted = 0;
  const missingRates = new Set();
  const receipts = user.receipts.map((r) => {
    const { rate, eur } = receiptInEur(r, rates);
    if (r.status === 'accepted') {
      accepted += 1;
      if (eur === null) missingRates.add(r.currency);
      else totalEur += eur;
    }
    return { ...r, rate, eur };
  });
  return {
    receipts,
    acceptedCount: accepted,
    rejectedCount: user.receipts.length - accepted,
    totalEur: round2(totalEur),
    missingRates: [...missingRates].sort(),
  };
}

export function groupSummary(users, rates) {
  const perUser = users.map((u) => ({ user: u, ...userSummary(u, rates) }));
  return {
    perUser,
    totalEur: round2(perUser.reduce((sum, s) => sum + s.totalEur, 0)),
    receiptCount: perUser.reduce((sum, s) => sum + s.acceptedCount, 0),
    missingRates: [...new Set(perUser.flatMap((s) => s.missingRates))].sort(),
  };
}

export function formatMoney(value) {
  return value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
