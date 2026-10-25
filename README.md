# Travel receipts app

An offline web app that runs on an Android tablet. Participants join the
tablet's Wi-Fi hotspot with their phones, fill in their details and upload
photos or PDFs of their travel receipts. The tablet is the admin view: it
shows every participant, converts all amounts to EUR, and exports the
documents to print and sign, an Excel summary and a ZIP of all originals.

No internet connection is needed while the app runs. Internet is only needed
once, to install it.

## How it works

- **Tablet** runs a small Node.js server in [Termux](https://termux.dev).
  Everything is stored on the tablet: `data/db.json` holds the details and
  amounts, `data/uploads/` holds every original file exactly as it was sent.
- **Phones** open `http://<tablet address>:8080/` in their browser. Each
  receipt is read on the phone itself (Tesseract OCR for photos and scanned
  PDFs, pdf.js for PDFs with real text). The detected total, currency, date
  and vendor are filled in for the participant to check and correct.
  Participants can send only once.
- **Admin view** opens only in a browser on the tablet itself, at
  `http://localhost:8080/admin`. Phones get "403 forbidden" there.

Receipt languages: English, Hungarian, Romanian, Turkish, Spanish, Polish and
Bulgarian. Each receipt is read with English plus the chosen language
(default comes from the participant's country, and can be changed per
receipt).

## Setting up the tablet (once, needs internet)

1. Install **Termux** from F-Droid (https://f-droid.org/packages/com.termux/).
   The Google Play version also works on Android 14.
2. Open Termux and run:

   ```sh
   pkg update
   pkg install nodejs-lts git
   termux-setup-storage   # optional: lets you copy exports to Downloads
   ```

3. Get the app onto the tablet and install its libraries:

   ```sh
   git clone https://github.com/darco918/ErasmusScannigApp.git
   cd ErasmusScannigApp
   npm ci --omit=dev
   ```

4. In Android settings, set Termux's battery usage to **Unrestricted**, so
   Android does not stop the server when the screen is off.

## Running it (offline)

1. Turn on the tablet's **Wi-Fi hotspot**. Mobile data can stay off.
2. In Termux:

   ```sh
   cd ~/ErasmusScannigApp
   termux-wake-lock
   npm start
   ```

   It prints the admin address and the address(es) for phones.
3. Open **Chrome on the tablet** at `http://localhost:8080/admin`.
4. Press **Show QR code**. Participants scan it after joining the hotspot.
5. Enter the **exchange rates** (how many units one euro buys, e.g.
   `1 EUR = 395.50 HUF`) under *Exchange rates and settings*. You can do this
   before or after people submit. Totals update straight away.

Stop the server with `Ctrl+C` in Termux. Data is kept between runs.

### If phones cannot open the page

- The QR code or address must be the tablet's **hotspot** address, usually
  `192.168.x.1`. If the admin page shows no address or a wrong one, find the
  address under Settings → Network → Hotspot → connected devices, or run
  `ip -4 addr` in Termux and use the `inet` address of the `wlan`/`ap`/`swlan`
  interface. Enter it as `http://192.168.x.1:8080/` under *Phone address*
  in the admin settings.
- Phones may warn that the Wi-Fi "has no internet". Choose **Stay connected**.
  If a phone keeps switching away, turn off its mobile data while uploading.
- The server must be running in Termux (the notification must show).

## Exports (admin view)

- **All documents (one PDF)**: one document per participant, each starting
  on a new page, ready to print and sign.
- **Excel summary**: *Summary* sheet with one row per participant and their
  EUR total, plus the group total at the bottom. *Receipts* sheet with every
  receipt (original amount, currency, rate, EUR). *Rates* sheet. Totals are
  live Excel formulas.
- **Everything (ZIP)**: `Country / 001 Lastname Firstname /` with each
  participant's original receipts and their document. Rejected receipts go
  in a `Rejected` subfolder. The combined PDF and the Excel file are at the
  top level.

Rejected receipts and receipts in a currency without a rate are left out of
the totals. Missing rates are flagged in the admin view, the documents and
the Excel file.

## Backups

Everything is in the `data` folder. Copy it somewhere safe from time to time,
for example `cp -r data ~/storage/downloads/receipts-backup` after running
`termux-setup-storage`. To keep data somewhere else, start the server with
`DATA_DIR=/path/to/folder npm start`. Use `PORT=9000 npm start` for another
port.

## Still to do

- **Document template**: `src/documents.js` draws a placeholder layout. It
  will be replaced with the real template once it is supplied.
- **Spending rules** (caps or excluded expenses): to be specified.

## Development

```sh
npm install
npm start          # http://localhost:8080 and http://localhost:8080/admin
npm test           # parser + server tests
npm run e2e        # browser test with real OCR (needs Playwright + Chromium)
```

Layout: `server.js` starts the server. `src/` holds the server code (storage,
validation, exports). `public/` is the phone page, and
`public/js/receipt-parse.js` is the receipt-reading logic. `admin/` is the
tablet view.
