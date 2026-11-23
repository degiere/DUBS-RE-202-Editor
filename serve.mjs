// Copyright (c) 2026, Chris De Giere <https://chrisdegiere.com>
// Licensed under CC BY-NC-SA 4.0. See LICENSE.
// Serves this folder on localhost so Chrome will grant Web MIDI and the folder picker, and never caches a file.
//     node serve.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.argv[2]) || 8772;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const SERVED = new Set(['index.html', 'probe.html', 'app.css', 'app.js', 're202.js', 'midi.js', 'editor.js', 'library.js', 'fake.js', 'bank.js']);

createServer(async (req, res) => {
  const name = normalize(decodeURIComponent(new URL(req.url, 'http://localhost').pathname)).replace(/^[/\\]+/, '') || 'index.html';
  if (req.method !== 'GET' || name.includes(sep) || !SERVED.has(name)) { res.writeHead(404).end('not found'); return; }
  try {
    const body = await readFile(join(root, name));
    res.writeHead(200, { 'Content-Type': TYPES[extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch (e) { res.writeHead(404).end('not found'); }
}).listen(port, '127.0.0.1', () => console.log(`RE-202 editor: http://localhost:${port}/`));
