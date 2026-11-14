import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createSorter } from './sorter.mjs';
import { createReview } from './review.mjs';
import sharp from 'sharp';

const directory = path.dirname(fileURLToPath(import.meta.url));
const assetTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const imageTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.tiff': 'image/tiff', '.tif': 'image/tiff' };

export function createApp(sorter, review) {
  const token = randomBytes(32).toString('hex');
  return http.createServer(async (request, response) => {
    const host = request.headers.host;
    if (!host || !/^127\.0\.0\.1:\d+$/.test(host)) { response.writeHead(403).end('Local access only.'); return; }
    const url = new URL(request.url, `http://${host}`);
    const json = (value, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    try {
      if (request.method === 'GET' && url.pathname === '/api/health') return json({ app: 'headshot-sorter', version: 1 });
      if (request.method === 'GET' && url.pathname === '/api/state') return json({ ...await sorter.state(), token });
      if (request.method === 'GET' && url.pathname === '/api/review' && review) return json({ ...await review.list(), token });
      if (request.method === 'GET' && url.pathname.startsWith('/api/review/image/') && review) {
        const file = await review.image(url.pathname.slice('/api/review/image/'.length));
        const thumbnail = url.searchParams.get('thumb') === '1';
        const bytes = thumbnail
          ? await sharp(file).rotate().resize({ width: 420, height: 420, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 84 }).toBuffer()
          : await fs.readFile(file);
        response.writeHead(200, { 'Content-Type': thumbnail ? 'image/jpeg' : imageTypes[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'private, max-age=300' });
        response.end(bytes);
        return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/image/')) {
        const file = await sorter.image(url.pathname.slice('/api/image/'.length));
        const bytes = await fs.readFile(file);
        response.writeHead(200, { 'Content-Type': imageTypes[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        response.end(bytes);
        return;
      }
      if (request.method === 'POST') {
        if (request.headers.origin !== `http://${host}` || request.headers['x-sorter-token'] !== token || !request.headers['content-type']?.startsWith('application/json')) {
          return json({ error: 'Open this app in its local browser tab to sort photos.' }, 403);
        }
        let body = '';
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 4096) { json({ error: 'Request is too large.' }, 413); return; }
        }
        let input;
        try { input = JSON.parse(body || '{}'); } catch { return json({ error: 'Invalid request.' }, 400); }
        if (url.pathname === '/api/review/mark' && review) return json(await review.mark(input.id, input.status));
        if (url.pathname === '/api/review/crop' && review) return json(await review.saveCrop(input.id, input.crop));
        if (url.pathname === '/api/rate') return json(await sorter.rate(input.id, input.rating, input.crop));
        if (url.pathname === '/api/undo') return json(await sorter.undo());
        if (url.pathname === '/api/skip') return json(await sorter.state({ exclude: input.id }));
        if (url.pathname === '/api/refresh') return json(await sorter.refresh());
      }
      if (request.method === 'GET' && ['/', '/index.html', '/app.js', '/style.css', '/review', '/review.html', '/review.js', '/review.css'].includes(url.pathname)) {
        const name = url.pathname === '/' ? 'index.html' : url.pathname === '/review' ? 'review.html' : url.pathname.slice(1);
        const contents = await fs.readFile(path.join(directory, 'public', name));
        response.writeHead(200, { 'Content-Type': assetTypes[path.extname(name)], 'Cache-Control': 'no-cache' });
        response.end(contents);
        return;
      }
      json({ error: 'Not found.' }, 404);
    } catch (error) {
      console.error(error.message);
      json({ error: error.code === 'ENOENT' ? 'This file was moved or removed. Refresh the queue to continue.' : error.message }, 400);
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const port = Number(option('--port', '4317'));
  const source = option('--source', 'C:\\Users\\User\\Downloads\\headshots');
  const destination = option('--destination', 'C:\\Users\\User\\Desktop\\headshots');
  const stateDir = option('--state-dir', path.join(directory, '.local'));
  const url = `http://127.0.0.1:${port}`;
  const open = () => {
    if (args.includes('--open') && process.platform === 'win32') {
      execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Process '${url}'`]);
    }
  };
  const sorter = await createSorter({ source, destination, stateDir });
  const review = await createReview({ destination, stateDir });
  const app = createApp(sorter, review);
  app.on('error', async error => {
    if (error.code === 'EADDRINUSE') {
      const health = await fetch(`${url}/api/health`).then(r => r.json()).catch(() => null);
      if (health?.app === 'headshot-sorter') { console.log(`Headshot sorter is already running: ${url}`); open(); return; }
    }
    console.error(error.message);
    process.exitCode = 1;
  });
  app.listen(port, '127.0.0.1', () => { console.log(`Headshot sorter ready: ${url}\nSource: ${source}\nDestination: ${destination}`); open(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
