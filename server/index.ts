import { resolve } from 'node:path';
import { createApp, lanAddresses } from './app';

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';
const dataFile = resolve(process.env.DATA_FILE ?? 'data/crowdmate.json');
const distDir = resolve(process.env.DIST_DIR ?? 'dist');

const app = createApp({ dataFile, distDir });

app.server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[crowdmate] Port ${port} is already in use. Close the other program or run with PORT=8090.`);
  } else {
    console.error('[crowdmate] server error', err);
  }
  process.exit(1);
});

app.server.listen(port, host, () => {
  console.log(`[crowdmate] server running on http://localhost:${port}`);
  for (const ip of lanAddresses()) console.log(`[crowdmate] on your Wi-Fi:      http://${ip}:${port}`);
  console.log(`[crowdmate] data file: ${dataFile}`);
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  console.log('\n[crowdmate] saving and shutting down…');
  app.close().then(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
