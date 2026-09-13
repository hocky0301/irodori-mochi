import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const documents = {
  '/': new URL('../index.html', import.meta.url),
  '/index.html': new URL('../index.html', import.meta.url),
  '/deck/mochi.html': new URL('../deck/mochi.html', import.meta.url),
};
createServer(async (request, response) => {
  const { pathname } = new URL(request.url, 'http://127.0.0.1');
  if (!documents[pathname]) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(documents[pathname]);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(body);
  } catch {
    response.writeHead(500).end();
  }
}).listen(4173, '127.0.0.1');
