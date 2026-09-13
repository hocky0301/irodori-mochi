import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const document = new URL('../index.html', import.meta.url);
createServer(async (request, response) => {
  const { pathname } = new URL(request.url, 'http://127.0.0.1');
  if (pathname !== '/' && pathname !== '/index.html') {
    response.writeHead(404).end();
    return;
  }
  try {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(await readFile(document));
  } catch {
    response.writeHead(500).end();
  }
}).listen(4173, '127.0.0.1');
