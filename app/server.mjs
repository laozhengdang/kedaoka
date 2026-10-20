// server.mjs —— 网页版入口（开发/备用）。桌面版请用 electron/main.mjs。
// 只用 Node 内置模块，零依赖。

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callApi, startImport, getJob } from './api.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
const DATA_DIR = process.env.MIAOMIAO_DATA || join(HERE, '..', 'data');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = decodeURIComponent(url.pathname);

  if (path.startsWith('/api/')) {
    try {
      if (path === '/api/import' && req.method === 'POST') {
        const b = await readBody(req);
        const job = startImport(b.file, b.courseName, b.kind || 'theory', b.docType || 'ppt');
        res.writeHead(200, { 'content-type': MIME['.json'] });
        return res.end(JSON.stringify({ job }));
      }
      if (path.startsWith('/api/job/')) {
        res.writeHead(200, { 'content-type': MIME['.json'] });
        return res.end(JSON.stringify(getJob(path.slice('/api/job/'.length))));
      }
      const body = req.method === 'POST' ? await readBody(req) : {};
      const out = callApi(req.method, path, body);
      res.writeHead(200, { 'content-type': MIME['.json'] });
      return res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { 'content-type': MIME['.json'] });
      return res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    }
  }

  // 图片：网页模式下从 data 目录读
  if (path.startsWith('/img/')) {
    const rel = decodeURIComponent(path.slice('/img/'.length));
    const file = normalize(join(DATA_DIR, 'images', rel));
    if (!file.startsWith(join(DATA_DIR, 'images'))) { res.writeHead(403); return res.end('forbidden'); }
    try {
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'image/png' });
      return res.end(await readFile(file));
    } catch {
      res.writeHead(404); return res.end('404');
    }
  }

  const rel = path === '/' ? '/index.html' : path;
  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not file');
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
});

const PORT = Number(process.env.PORT || 5173);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  老郑荡的妙妙小工具（网页版）`);
  console.log(`  http://127.0.0.1:${PORT}\n`);
});
