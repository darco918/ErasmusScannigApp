import path from 'node:path';
import { createApp } from './src/app.js';
import { lanAddresses } from './src/network.js';
import { openStore } from './src/store.js';

const port = Number(process.env.PORT) || 8080;
const dataDir = path.resolve(process.env.DATA_DIR || path.join(import.meta.dirname, 'data'));

const store = await openStore(dataDir);
const app = createApp(store);

app.listen(port, '0.0.0.0', () => {
  console.log(`Receipt app running. Data folder: ${dataDir}`);
  console.log(`  Admin (on this tablet): http://localhost:${port}/admin`);
  const addresses = lanAddresses();
  if (addresses.length) {
    for (const ip of addresses) console.log(`  Phones:                 http://${ip}:${port}/`);
  } else {
    console.log('  Phones: use the tablet hotspot address (see README), port ' + port);
  }
});
