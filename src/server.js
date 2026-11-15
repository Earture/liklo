'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const bilibili = require('./bilibili');
const pipeline = require('./pipeline');
const monitor = require('./monitor');
const util = require('./util');
const transcribe = require('./transcribe');
const names = require('./names');
const staticsite = require('./staticsite');
const cache = require('./cache');

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
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data.replace(/^\uFEFF/, '')));
      } catch (e) {
        reject(new Error('invalid JSON body: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${config.PORT}`);
    const p = url.pathname;

    // ---------- API ----------
    if (p.startsWith('/api/')) {
      if (p === '/api/health') {
        return sendJson(res, 200, { ok: true, model: config.LLM_MODEL, asr: config.ASR_MODEL });
      }

      // ---------- service configuration (editable from the page) ----------
      if (p === '/api/settings' && req.method === 'GET') {
        return sendJson(res, 200, config.currentSettings());
      }
      if (p === '/api/settings' && req.method === 'POST') {
        const body = await readBody(req);
        if (body && body.reset) return sendJson(res, 200, config.resetSettings());
        return sendJson(res, 200, config.saveSettings(body));
      }

      // ---------- B站 cookies (imported from the page) ----------
      if (p === '/api/cookies' && req.method === 'GET') {
        return sendJson(res, 200, bilibili.cookieStatus());
      }
      if (p === '/api/cookies' && req.method === 'POST') {
        const body = await readBody(req);
        const entries = bilibili.parseCookies(body.text || '');
        if (!entries.length) {
          return sendJson(res, 400, { error: '文件里没有可解析的 cookie：需要浏览器导出的 cookies.txt，或 name=value; name2=value2 形式的 Cookie 头' });
        }
        fs.mkdirSync(config.DATA_DIR, { recursive: true });
        // rewritten as Netscape format so yt-dlp can read the same file
        fs.writeFileSync(config.COOKIE_STORE, bilibili.toNetscape(entries), 'utf8');
        config.COOKIE_FILE = config.COOKIE_STORE;
        bilibili.reloadCookies();
        return sendJson(res, 200, bilibili.cookieStatus());
      }
      if (p === '/api/cookies' && req.method === 'DELETE') {
        try {
          fs.unlinkSync(config.COOKIE_STORE);
        } catch {
          /* nothing imported */
        }
        config.COOKIE_FILE = config.COOKIE_DEFAULT;
        bilibili.reloadCookies();
        return sendJson(res, 200, bilibili.cookieStatus());
      }
      if (p === '/api/cookies/verify' && req.method === 'POST') {
        const body = await readBody(req);
        const mid = bilibili.extractMid(body.mid || body.url) || (db.listStreamers().find((s) => s.monitor) || db.listStreamers()[0] || {}).mid;
        if (!mid) return sendJson(res, 400, { error: '验证需要一个 mid：添加主播或在验证前填写 mid' });
        return sendJson(res, 200, await bilibili.probeCookies(mid));
      }

      // Liveness probe: does the ASR backend actually return a transcription, and is
      // the LLM reachable? A 2s tone is sent to ASR; a timeout means the request reached
      // the backend but the model never produced output.
      if (p === '/api/services-status' && req.method === 'GET') {
        const timeoutMs = Number(url.searchParams.get('timeout') || config.ASR_PING_TIMEOUT_MS);
        const asr = await transcribe.probeAsr(timeoutMs);
        let llm = { ok: false, error: 'not checked' };
        try {
          const r = await util.httpGet(`${config.LLM_BASE}/models`, { Authorization: `Bearer ${config.LLM_API_KEY}` }, 15000);
          let models = [];
          try {
            models = (JSON.parse(r.text).data || []).map((m) => m.id);
          } catch {
            /* ignore */
          }
          llm = { ok: r.status === 200, status: r.status, models, available: models.includes(config.LLM_MODEL) };
        } catch (e) {
          llm = { ok: false, error: String(e.message || e) };
        }
        return sendJson(res, 200, {
          asr: { ...asr, model: config.ASR_MODEL, base: config.ASR_BASE, timeoutMs },
          llm: { ...llm, model: config.LLM_MODEL, base: config.LLM_BASE },
          segmentSeconds: config.MAX_SEGMENT_SECONDS,
        });
      }

      if (p === '/api/streamers' && req.method === 'GET') {
        return sendJson(res, 200, db.listStreamers());
      }
      if (p === '/api/streamers' && req.method === 'POST') {
        const body = await readBody(req);
        const mid = body.mid || bilibili.extractMid(body.url) || (body.url ? (await bilibili.getVideoInfo(body.url)).mid : null);
        if (!mid) return sendJson(res, 400, { error: '需要 UP 主页链接或 mid' });
        const name = body.name || (await bilibili.getOwnerName(mid)) || `UP-${mid}`;
        let hints = [name];
        try {
          hints.push(...(await bilibili.listSpaceVideos(mid, 10)).map((v) => v.title));
        } catch {
          /* title hints are optional */
        }
        const english = body.english || util.englishName(hints, String(mid));
        const s = db.upsertStreamer({
          mid,
          name,
          english,
          keywords: body.keywords,
          match: body.match,
          monitor: body.monitor,
        });
        return sendJson(res, 200, s);
      }
      const streamerMatch = p.match(/^\/api\/streamers\/([^\/]+)$/);
      if (streamerMatch && req.method === 'DELETE') {
        return sendJson(res, 200, db.deleteStreamer(streamerMatch[1]));
      }
      const monMatch = p.match(/^\/api\/streamers\/(\d+)\/monitor$/);
      if (monMatch && req.method === 'POST') {
        const body = await readBody(req);
        const s = db.setMonitor(monMatch[1], !!body.on);
        return sendJson(res, 200, s);
      }

      if (p === '/api/monitor/run' && req.method === 'POST') {
        // start one discovery pass now instead of waiting for the interval;
        // the pass is async so the request returns immediately and the UI polls
        // /api/monitor/status for progress
        const body = await readBody(req);
        return sendJson(res, 200, monitor.runNow({ rediscover: !!body.rediscover }));
      }
      if (p === '/api/monitor/status' && req.method === 'GET') {
        return sendJson(res, 200, monitor.getStatus());
      }

      // ---------- name table (used by the name-correction pass, src/names.js) ----------
      if (p === '/api/names' && req.method === 'GET') {
        return sendJson(res, 200, db.listNames());
      }
      if (p === '/api/names' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.name) return sendJson(res, 400, { error: 'name is required' });
        const row = db.upsertName({
          name: body.name,
          english: body.english,
          aliases: body.aliases,
          mishearings: body.mishearings,
          note: body.note,
          source: 'user',
        });
        return sendJson(res, 200, row);
      }
      const nameMatch = p.match(/^\/api\/names\/(\d+)$/);
      if (nameMatch) {
        if (req.method === 'PUT') {
          const body = await readBody(req);
          const row = db.updateName(Number(nameMatch[1]), body);
          if (!row) return sendJson(res, 404, { error: 'name not found' });
          return sendJson(res, 200, row);
        }
        if (req.method === 'DELETE') {
          return sendJson(res, 200, { deleted: db.deleteName(Number(nameMatch[1])) });
        }
      }
      if (p === '/api/names/seed' && req.method === 'POST') {
        return sendJson(res, 200, {
          added: names.seedFromStreamers().concat(names.seedFromJobs()),
        });
      }

      if (p === '/api/reports' && req.method === 'GET') {
        // report library: every completed report, optionally filtered
        return sendJson(res, 200, db.listReports({
          limit: Number(url.searchParams.get('limit') || 200),
          streamer: url.searchParams.get('streamer') || null,
          q: url.searchParams.get('q') || null,
        }));
      }
      const markdownMatch = p.match(/^\/api\/reports\/(\d+)\/markdown$/);
      if (markdownMatch && req.method === 'GET') {
        const job = db.getJob(Number(markdownMatch[1]));
        if (!job || !job.report) return sendJson(res, 404, { error: '该任务没有报告' });
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="report-${pipeline.partKey(job) || job.id}.md"`,
        });
        return res.end(`# ${job.title || job.bvid}\n\n来源: ${job.url}\n主播: ${job.streamer_name || ''}\n生成时间: ${job.updated_at}\n\n${job.report}\n`);
      }

      const fixNamesMatch = p.match(/^\/api\/reports\/(\d+)\/fix-names$/);
      if (fixNamesMatch && req.method === 'POST') {
        const result = await names.correctNames(Number(fixNamesMatch[1]));
        staticsite.scheduleBuild('name fixes');
        return sendJson(res, 200, result);
      }

      // ---------- static export of the report library (src/staticsite.js) ----------
      if (p === '/api/site/export' && req.method === 'POST') {
        try {
          return sendJson(res, 200, staticsite.build());
        } catch (e) {
          return sendJson(res, 500, { error: String(e.message || e) });
        }
      }
      if (p === '/api/site/status' && req.method === 'GET') {
        return sendJson(res, 200, staticsite.status());
      }

      // ---------- audio cache (src/cache.js) ----------
      if (p === '/api/cache/audio' && req.method === 'GET') {
        return sendJson(res, 200, cache.stats());
      }
      if (p === '/api/cache/audio/clear' && req.method === 'POST') {
        const body = await readBody(req);
        try {
          return sendJson(res, 200, cache.clearAudioCache({ includeOrphans: body.includeOrphans !== false }));
        } catch (e) {
          return sendJson(res, 500, { error: String(e.message || e) });
        }
      }

      if (p === '/api/jobs' && req.method === 'GET') {
        // paginated task list: ?limit=20&offset=20&status=done
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)));
        const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
        const status = url.searchParams.get('status') || null;
        return sendJson(res, 200, {
          total: db.countJobs(status),
          counts: db.jobStatusCounts(),
          limit,
          offset,
          status,
          jobs: db.listJobs({ limit, offset, status }),
        });
      }
      if (p === '/api/jobs' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.url) return sendJson(res, 400, { error: 'url is required' });
        const streamer = body.streamerId ? db.getStreamer(body.streamerId) : null;
        // allParts=true overrides the "only P1" default for multi-part videos
        const job = await pipeline.createJob(body.url, { auto: 0, streamer, allParts: Boolean(body.allParts) });
        return sendJson(res, 201, job);
      }
      const jobMatch = p.match(/^\/api\/jobs\/(\d+)$/);
      if (jobMatch) {
        const id = Number(jobMatch[1]);
        if (req.method === 'DELETE') {
          // ?purge=1 also deletes the downloaded audio, transcript and ASR cache
          const result = pipeline.deleteJob(id, url.searchParams.get('purge') === '1');
          if (!result) return sendJson(res, 404, { error: 'job not found' });
          return sendJson(res, 200, result);
        }
        const job = db.getJob(id);
        if (!job) return sendJson(res, 404, { error: 'job not found' });
        if (req.method === 'POST') {
          // re-run a job that is waiting, failed or was cancelled
          const next = pipeline.startJob(id);
          return sendJson(res, 200, next);
        }
        return sendJson(res, 200, job);
      }
      const cancelMatch = p.match(/^\/api\/jobs\/(\d+)\/cancel$/);
      if (cancelMatch && req.method === 'POST') {
        const job = pipeline.cancelJob(Number(cancelMatch[1]));
        if (!job) return sendJson(res, 404, { error: 'job not found' });
        return sendJson(res, 200, job);
      }
      // start one part of a multi-P video (the parts 2+ are created but not run)
      const startMatch = p.match(/^\/api\/jobs\/(\d+)\/start$/);
      if (startMatch && req.method === 'POST') {
        const job = pipeline.startJob(Number(startMatch[1]));
        if (!job) return sendJson(res, 404, { error: 'job not found' });
        return sendJson(res, 200, job);
      }
      // parts of this video that have no job yet: create them (not started)
      const partsMatch = p.match(/^\/api\/jobs\/(\d+)\/parts$/);
      if (partsMatch && req.method === 'POST') {
        const id = Number(partsMatch[1]);
        const job = db.getJob(id);
        if (!job) return sendJson(res, 404, { error: 'job not found' });
        const body = await readBody(req);
        const created = await pipeline.createJob(job.url, { auto: 0, allParts: Boolean(body.all) });
        return sendJson(res, 200, { created: created.id, parts: db.listJobsByBvid(created.bvid) });
      }
      const transcriptMatch = p.match(/^\/api\/jobs\/(\d+)\/transcript$/);
      if (transcriptMatch && req.method === 'GET') {
        // raw timestamped transcript (segments with absolute offsets) for download
        const job = db.getJob(Number(transcriptMatch[1]));
        if (!job) return sendJson(res, 404, { error: 'job not found' });
        const tp = pipeline.transcriptPathFor(job);
        if (!fs.existsSync(tp)) return sendJson(res, 404, { error: '该任务还没有转录结果' });
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="transcript-${pipeline.partKey(job)}.json"`,
        });
        return res.end(fs.readFileSync(tp, 'utf8'));
      }

      const timelineMatch = p.match(/^\/api\/jobs\/(\d+)\/timeline$/);
      if (timelineMatch && req.method === 'GET') {
        // segments with absolute offsets, for the timestamped transcript view
        const job = db.getJob(Number(timelineMatch[1]));
        if (!job) return sendJson(res, 404, { error: 'job not found' });
        const tp = pipeline.transcriptPathFor(job);
        if (!fs.existsSync(tp)) return sendJson(res, 404, { error: '该任务还没有转录结果' });
        let transcript;
        try {
          transcript = JSON.parse(fs.readFileSync(tp, 'utf8'));
        } catch (e) {
          return sendJson(res, 500, { error: '转录文件损坏: ' + e.message });
        }
        return sendJson(res, 200, {
          bvid: job.bvid,
          part: job.part || 1,
          url: job.url,
          duration: transcript.duration || job.duration || null,
          segments: transcript.segments || [],
          text: transcript.text || '',
        });
      }

      const reportMatch = p.match(/^\/api\/jobs\/(\d+)\/report$/);
      if (reportMatch && req.method === 'POST') {
        // regenerate the report from the cached transcript (no download, no ASR)
        try {
          const job = await pipeline.regenerateReport(Number(reportMatch[1]));
          if (!job) return sendJson(res, 404, { error: 'job not found' });
          return sendJson(res, 200, job);
        } catch (e) {
          return sendJson(res, 500, { error: String(e.message || e) });
        }
      }

      // re-run the ASR step with the currently configured service: transcript + cache are
      // deleted first, the downloaded audio and the segments are reused
      const transcribeMatch = p.match(/^\/api\/jobs\/(\d+)\/transcribe$/);
      if (transcribeMatch && req.method === 'POST') {
        try {
          const job = pipeline.retranscribeJob(Number(transcribeMatch[1]));
          if (!job) return sendJson(res, 404, { error: 'job not found' });
          return sendJson(res, 200, job);
        } catch (e) {
          return sendJson(res, 500, { error: String(e.message || e) });
        }
      }

      return sendJson(res, 404, { error: 'not found' });
    }

    // ---------- static ----------
    // convenience hop to the read-only public report page on its own port
    if (p === '/public' || p === '/public-reports') {
      const host = (req.headers.host || 'localhost').replace(/:\d+$/, '');
      res.writeHead(302, { Location: `http://${host}:${config.PUBLIC_PORT}/` });
      return res.end();
    }

    let file = p === '/' ? '/index.html' : p;
    if (p === '/reports') file = '/reports.html';
    const filePath = path.join(PUBLIC_DIR, file);
    if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    // no-cache + ETag so edits to public/*.js or style.css take effect on the
    // next reload instead of being served from the browser cache
    const stat = fs.statSync(filePath);
    const etag = '"' + stat.mtime.getTime() + '-' + stat.size + '"';
    const headers = {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, headers);
    res.end(fs.readFileSync(filePath));
  } catch (e) {
    console.error('[server] error:', e);
    sendJson(res, 500, { error: String(e.message || e) });
  }
});

process.on('unhandledRejection', (e) => {
  console.error('[server] unhandled rejection:', e);
});

server.listen(config.PORT, () => {
  console.log(`liklo server listening on http://localhost:${config.PORT}`);
  const migrated = pipeline.migrateReports();
  if (migrated) console.log(`[server] restructured ${migrated} stored report(s)`);
  const interrupted = db.recoverInterruptedJobs();
  if (interrupted.length) {
    console.log(`[server] resuming ${interrupted.length} interrupted job(s): ${interrupted.join(', ')}`);
    for (const id of interrupted) pipeline.enqueue(id);
  }
  monitor.start();
});
