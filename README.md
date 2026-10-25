# Travel receipts app

An offline web app that runs on an Android tablet. The tablet and the
participants' phones join the same Wi-Fi (a phone's hotspot or a small travel
router, no internet needed). Participants fill in their details and upload
photos or PDFs of their travel tickets and receipts. The tablet is the admin
view: it shows every participant, converts all amounts to EUR, and exports a
filled-in "Travel costs reimbursement form" per person to print and sign, an
Excel summary and a ZIP of all originals.

No internet connection is needed while the app runs. Internet is only needed
once, to install it.

## How it works

- **Tablet** runs a small Node.js server in [Termux](https://termux.dev).
  Everything is stored on the tablet: `data/db.json` holds the details and
  amounts, `data/uploads/` holds every original file exactly as it was sent.
- **Projects**: the first time the admin view opens it asks for the project
  title, project number, host country and first/last day. Phones always submit
  to the *active* project. **New project** starts an empty one; earlier
  projects are never deleted and can be opened, edited, exported or made
  active again from the project list.
- **Phones** open `http://<tablet address>:8080/` in their browser and go
  through three steps: *Details*, *Receipts*, *Send*. Receipts can be added
  one photo at a time or several files at once, and show as a list marked
  *Ready* or *Needs details*; tapping one opens it for checking. Each receipt
  is one journey (one row of the form). It is read on the phone itself
  (Tesseract OCR for photos and scanned PDFs, pdf.js for PDFs with real text)
  in the participant's language, the host country's language and English:
  amount, currency, date, means of transport (PLANE, CARPOOLING, BUS, TRAIN)
  and From/To city and country are suggested for the participant to check.
  From, To, transport and date are required. The unsent form is kept on the
  phone, so a reload (common after taking a photo) loses nothing.
  Participants can send only once.
- **Admin view** has tabs: *Overview* (a checklist of what to do next),
  *Participants* (filter by to check / checked / problems), *Exchange rates*,
  *Print & export* and *Project*. On a participant's page every change is
  saved automatically, photos enlarge with a tap, and **Mark as checked &
  next** moves through everyone in turn.
- **Admin view** opens only in a browser on the tablet itself, at
  `http://localhost:8080/admin`, and asks for a PIN (`080900`). Phones get
  "403 forbidden" there. After 5 wrong PINs it waits a minute. **Lock** in the
  top bar closes it again; restarting the app also asks for the PIN again.
  To use another PIN, start with `ADMIN_PIN=123456 npm start`.

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

1. Turn on the Wi-Fi network: a phone's **hotspot** (mobile data can be off)
   or a travel router. Connect the tablet to it. Phones join the same network.
   Phone hotspots usually allow about 8–10 devices at a time.
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
   `1 EUR = 395.50 HUF`) under *Exchange rates and settings*. Rates belong to
   the project. You can do this before or after people submit; totals update
   straight away.

The very first time, step 3 shows **Set up your project** instead.

Stop the server with `Ctrl+C` in Termux. Data is kept between runs.

### If phones cannot open the page

- The address can change each time the tablet joins a network, so open the
  QR code after connecting. If the admin page shows no address or a wrong one,
  run `ip -4 addr | grep inet` in Termux and use the address that is not
  `127.0.0.1`. Enter it as `http://THAT-ADDRESS:8080/` under *Phone address*
  in the admin settings.
- Some phones do not let other devices reach the phone sharing the hotspot.
  Participants on *other* phones joining the hotspot are not affected.
- Phones may warn that the Wi-Fi "has no internet". Choose **Stay connected**.
  If a phone keeps switching away, turn off its mobile data while uploading.
- The server must be running in Termux (the notification must show).

## Exports (admin view)

All exports are for the project being viewed.

- **All forms (one PDF)**: the "Travel costs reimbursement form", one page per
  participant, ready to print and sign. Each accepted receipt is a row (From,
  To, means of transport, date, price in the other currency, price in EUR);
  more than 13 rows shrink to stay on one page. The exchange rates row lists
  the rates that person's receipts used. The confirmation sentence states the
  amount to reimburse, and the date at the bottom is the project's last day.
- **Excel summary**: *Summary* sheet with one row per participant (sum,
  optional cap, reimbursed) and the group total. *Receipts* sheet with every
  receipt. *Rates* and *Project* sheets. Totals are live Excel formulas.
- **Everything (ZIP)**: `Country / 001 Lastname Firstname /` with each
  participant's original receipts and their form. Rejected receipts go in a
  `Rejected` subfolder. The combined PDF and the Excel file are at the top
  level.

A **cap** (maximum reimbursement in EUR) can be set for an individual
participant on their page. The form's "Total 100%" still shows the full sum;
the confirmation sentence shows the capped amount.

Rejected receipts and receipts in a currency without a rate are left out of
the totals. Missing rates are flagged in the admin view, the documents and
the Excel file.

## Backups

Everything is in the `data` folder, saved on every change, so stopping the
server or the tablet loses nothing. Once a day the app also keeps a dated copy
of the database in `data/backups/`. Copy it somewhere safe from time to time,
for example `cp -r data ~/storage/downloads/receipts-backup` after running
`termux-setup-storage`. To keep data somewhere else, start the server with
`DATA_DIR=/path/to/folder npm start`. Use `PORT=9000 npm start` for another
port.

## Development

```sh
npm install
npm start          # http://localhost:8080 and http://localhost:8080/admin
npm test           # parser + server tests
npm run e2e        # browser test with real OCR (needs Playwright + Chromium)
```

Layout: `server.js` starts the server. `src/` holds the server code (storage,
validation, exports). `public/` is the phone page, and
`public/js/receipt-parse.js` is the receipt-reading logic (with known cities
and airport codes in `public/js/places.js`). `src/documents.js` draws the form.
`admin/` is the tablet view. `assets/fonts/` holds Liberation Sans (SIL Open
Font License), metric-compatible with Arial as used by the template.
