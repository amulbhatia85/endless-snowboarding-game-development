// Tiny static server for the production build (QA rig; not part of the app).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const ROOT = process.argv[2] ?? '/home/user/endless-snowboarding-game-development/dist';
const PORT = Number(process.argv[3] ?? 8931);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path = join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    const data = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(PORT, '0.0.0.0', () => console.log(`serving ${ROOT} on http://0.0.0.0:${PORT}`));
