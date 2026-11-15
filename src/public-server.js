'use strict';
// Read-only report library served on its own port (default 3210) so the finished
// reports can be shared with other people. No job control, no editing: only the
// report text, the timestamped transcript and the Markdown download.
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const { transcriptPathFor } = require('./util');

const PUBLIC_DIR = path.join(config.ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

/** transcript file of a done job, or null */
function readTranscript(row) {
  const tp = transcriptPathFor(row);
  if (!fs.existsSync(tp)) return null;
  try {
    return JSON.parse(fs.readFileSync(tp, 'utf8'));
  } catch (e) {
    return { error: '转录文件损坏: ' + e.message };
  }
}

function serveStatic(res, req, file) {
  const filePath = path.join(PUBLIC_DIR, file);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
  const stat = fs.statSync(filePath);
  const etag = '"' + stat.mtime.getTime() + '-' + stat.size + '"';
  const headers = {
    'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
    // reports are generated continuously, so never serve a stale page from cache
    'Cache-Control': 'no-cache',
    ETag: etag,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  res.end(fs.readFileSync(filePath));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${config.PUBLIC_PORT}`);
    const p = url.pathname;

    if (p.startsWith('/api/')) {
      if (p === '/api/health') {
        return sendJson(res, 200, { ok: true, mode: 'read-only', reports: db.listReports({ limit: 1 }).length });
      }

      if (p === '/api/reports' && req.method === 'GET') {
        return sendJson(res, 200, db.listReports({
          limit: Number(url.searchParams.get('limit') || 200),
          streamer: url.searchParams.get('streamer') || null,
          q: url.searchParams.get('q') || null,
        }));
      }

      const one = p.match(/^\/api\/reports\/([^\/]+)$/);
      if (one && req.method === 'GET') {
        const row = byIdOrBvid(one[1]);
        if (!row) return sendJson(res, 404, { error: '报告不存在' });
        return sendJson(res, 200, row);
      }

      const markdownMatch = p.match(/^\/api\/reports\/([^\/]+)\/markdown$/);
      if (markdownMatch && req.method === 'GET') {
        const row = byIdOrBvid(markdownMatch[1]);
        if (!row || !row.report) return sendJson(res, 404, { error: '该任务没有报告' });
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="report-${row.bvid || row.id}.md"`,
        });
        return res.end(`# ${row.title || row.bvid}\n\n来源: ${row.url}\n主播: ${row.streamer_name || ''}\n生成时间: ${row.updated_at}\n\n${row.report}\n`);
      }

      // timestamped transcript, for reading along with the report
      const timelineMatch = p.match(/^\/api\/reports\/([^\/]+)\/timeline$/);
      if (timelineMatch && req.method === 'GET') {
        const row = byIdOrBvid(timelineMatch[1]);
        if (!row) return sendJson(res, 404, { error: '报告不存在' });
        const transcript = readTranscript(row);
        if (!transcript) return sendJson(res, 404, { error: '该任务还没有转录结果' });
        if (transcript.error) return sendJson(res, 500, { error: transcript.error });
        return sendJson(res, 200, {
          bvid: row.bvid,
          url: row.url,
          duration: transcript.duration || row.duration || null,
          segments: transcript.segments || [],
          text: transcript.text || '',
        });
      }

      return sendJson(res, 404, { error: 'not found' });
    }

    // ---------- static / pages ----------
    if (p === '/' || p === '/reports') return serveStatic(res, req, 'view.html');
    const deep = p.match(/^\/r\/(BV[^\/]+)$/i);
    if (deep) return serveStatic(res, req, 'view.html');
    return serveStatic(res, req, p);
  } catch (e) {
    console.error('[public] error:', e);
    sendJson(res, 500, { error: String(e.message || e) });
  }
});

function byIdOrBvid(key) {
  if (/^\d+$/.test(key)) return db.getJob(Number(key));
  return db.getJobByBvid(key);
}

process.on('unhandledRejection', (e) => {
  console.error('[public] unhandled rejection:', e);
});

server.listen(config.PUBLIC_PORT, config.PUBLIC_HOST, () => {
  console.log(`liklo public report library: http://localhost:${config.PUBLIC_PORT} (listening on ${config.PUBLIC_HOST}:${config.PUBLIC_PORT})`);
});
