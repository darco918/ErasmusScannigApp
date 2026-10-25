import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, parseReceipt, findDate } from '../public/js/receipt-parse.js';

test('parseAmount handles European and English number formats', () => {
  assert.equal(parseAmount('45,90'), 45.9);
  assert.equal(parseAmount('45.90'), 45.9);
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.equal(parseAmount('1,234.56'), 1234.56);
  assert.equal(parseAmount('12 340'), 12340);
  assert.equal(parseAmount('1.234'), 1234);
  assert.equal(parseAmount('1.234.567'), 1234567);
  assert.equal(parseAmount('7'), 7);
  assert.equal(parseAmount('abc'), null);
});

test('findDate reads day-first and year-first dates', () => {
  assert.equal(findDate('Data: 12.05.2025 14:33'), '2025-05-12');
  assert.equal(findDate('2025.05.12. 14:33'), '2025-05-12');
  assert.equal(findDate('Fecha 03/02/2025'), '2025-02-03');
  assert.equal(findDate('31.02.2025'), null);
});

const samples = [
  {
    name: 'English',
    text: `CITY CAB LTD
Receipt
Date 14/03/2025 09:12
Fare 38.50
Tip 4.00
Subtotal 42.50
VAT 20% 7.08
TOTAL £42.50
Card 42.50`,
    expected: { amount: 42.5, currency: 'GBP', date: '2025-03-14', vendor: 'CITY CAB LTD' },
  },
  {
    name: 'Hungarian',
    text: `MÁV-START Zrt.
NYUGTA
2025.04.02. 08:15
Menetjegy 1 db      9 990 Ft
Helyjegy 1 db       2 350 Ft
ÖSSZESEN:          12 340 Ft
KÉSZPÉNZ           15 000 Ft
VISSZAJÁRÓ          2 660 Ft`,
    expected: { amount: 12340, currency: 'HUF', date: '2025-04-02', vendor: 'MÁV-START Zrt.' },
  },
  {
    name: 'Romanian',
    text: `SC PETROM SA
BON FISCAL
Benzina 95      231,45
TOTAL TVA        36,95
TOTAL           231,45 LEI
NUMERAR         250,00
REST             18,55
DATA: 21.05.2025`,
    expected: { amount: 231.45, currency: 'RON', date: '2025-05-21', vendor: 'SC PETROM SA' },
  },
  {
    name: 'Turkish',
    text: `HAVAIST OTOBÜS
FİŞ NO: 0042
TARİH: 10.06.2025
BİLET           *250,00
TOPKDV           *41,67
TOPLAM          *250,00 TL`,
    expected: { amount: 250, currency: 'TRY', date: '2025-06-10', vendor: 'HAVAIST OTOBÜS' },
  },
  {
    name: 'Spanish',
    text: `RENFE VIAJEROS
Factura simplificada
Fecha: 05/07/2025
Base imponible 37,19
IVA 10% 3,72
TOTAL A PAGAR 40,91 €`,
    expected: { amount: 40.91, currency: 'EUR', date: '2025-07-05', vendor: 'RENFE VIAJEROS' },
  },
  {
    name: 'Polish',
    text: `PKP Intercity S.A.
PARAGON FISKALNY
2025-08-11
Bilet normalny 1 x 89,99
PTU A 23% 16,83
SUMA PLN 89,99
Gotówka 100,00
Reszta 10,01`,
    expected: { amount: 89.99, currency: 'PLN', date: '2025-08-11', vendor: 'PKP Intercity S.A.' },
  },
  {
    name: 'Bulgarian',
    text: `ТАКСИ ОК СУПЕРТРАНС
ФИСКАЛЕН БОН
Дата 18.09.2025
Превоз           23,40
ДДС               3,90
ОБЩО             23,40 лв
В БРОЙ           30,00
РЕСТО             6,60`,
    expected: { amount: 23.4, currency: 'BGN', date: '2025-09-18', vendor: 'ТАКСИ ОК СУПЕРТРАНС' },
  },
  {
    name: 'Total label on its own line',
    text: `Hotel Bellevue
Invoice 2025-001
Issued 01.10.2025
Room 3 nights
Total amount
EUR 1.234,50`,
    expected: { amount: 1234.5, currency: 'EUR', date: '2025-10-01', vendor: 'Hotel Bellevue' },
  },
];

for (const sample of samples) {
  test(`parseReceipt: ${sample.name}`, () => {
    const result = parseReceipt(sample.text);
    for (const [key, value] of Object.entries(sample.expected)) {
      assert.equal(result[key], value, `${key} for ${sample.name}`);
    }
    assert.equal(result.confidence, 'high');
  });
}

test('parseReceipt falls back to the largest decimal figure and the currency hint', () => {
  const result = parseReceipt('Something\n12.50\n3.20', { currency: 'RON' });
  assert.equal(result.amount, 12.5);
  assert.equal(result.confidence, 'low');
  assert.equal(result.currency, 'RON');
});

test('parseReceipt copes with empty text', () => {
  const result = parseReceipt('');
  assert.equal(result.amount, null);
  assert.equal(result.confidence, 'none');
});
