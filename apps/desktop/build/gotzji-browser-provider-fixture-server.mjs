import { URL } from 'node:url';
/* global process, console */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
const bytes = await readFile(new URL('./gotzji-browser-provider-fixture.html', import.meta.url));
const server = http.createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== '/qualification.html') { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'" });
  response.end(bytes);
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/qualification.html`, pid: process.pid, fixtureOnly: true })));
for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => server.close(() => process.exit(0)));
