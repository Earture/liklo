'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const config = require('./config');

/**
 * POST with the built-in http module.
 * Node's fetch (undici) enforces a ~300s "headers timeout", which kills long ASR /
 * LLM requests with "fetch failed / Headers Timeout Error" while the service is
 * still working. http.request has no such limit, so long requests survive.
 */
function httpPost(url, body, headers = {}, signal, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
    const req = http.request(
      {
        protocol: u.protocol,
        host: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: Object.assign({ 'Content-Length': payload.length }, headers),
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      }
    );
    req.on('error', (e) => reject(new Error(`${e.message} [POST ${u.host}${u.pathname}]`)));
    if (timeoutMs) req.on('timeout', () => req.destroy(new Error(`no response from ${u.host} after ${timeoutMs / 1000}s`)));
    if (signal) {
      const abort = () => req.destroy(new Error('cancelled'));
      if (signal.aborted) return req.destroy(new Error('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', abort));
    }
    req.write(payload);
    req.end();
  });
}

function httpGet(url, headers = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        protocol: u.protocol,
        host: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers,
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      }
    );
    req.on('error', (e) => reject(new Error(`${e.message} [GET ${u.host}${u.pathname}]`)));
    if (timeoutMs) req.on('timeout', () => req.destroy(new Error(`no response from ${u.host} after ${timeoutMs / 1000}s`)));
    req.end();
  });
}

function run(cmd, args, opts = {}) {
  const { signal, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, ...spawnOpts });
    let out = '';
    let err = '';
    if (signal) {
      const kill = () => { try { p.kill(); } catch {} };
      if (signal.aborted) kill();
      else signal.addEventListener('abort', kill, { once: true });
    }
    p.stdout.on('data', (d) => (out += d.toString('utf8')));
    p.stderr.on('data', (d) => (err += d.toString('utf8')));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`${cmd} exited with code ${code}: ${err.slice(0, 800)}`));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Strip spaces/special chars, keep ASCII letters/digits, lowercase. */
function sanitizeName(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .toLowerCase() || 'streamer';
}

function yyyymmdd(d = new Date()) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

const NAME_STOPWORDS = new Set([
  'official', 'vtuber', 'bilibili', 'live', 'livestream', 'replay', 'recording',
  'channel', 'tv', 'com', 'www', 'the', 'and', 'with', 'studio', 'fan', 'club',
  'stream', 'gaming', 'hd', 'audio', 'video', 'clip', 'highlight', 'part',
]);

/**
 * Best-effort "english name" for output file naming: takes the most frequent
 * latin run in the given texts (e.g. "莉蔻Liko" -> "liko"), ignoring generic
 * words such as "official". Accepts a string or an array of strings.
 */
function englishName(texts, fallback = 'streamer') {
  const arr = (Array.isArray(texts) ? texts : [texts]).map(String).filter(Boolean);
  const counts = new Map();
  for (const t of arr) {
    const seen = new Set();
    for (const run of t.match(/[A-Za-z][A-Za-z0-9]{1,20}/g) || []) {
      const key = run.toLowerCase();
      if (NAME_STOPWORDS.has(key) || seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0];
  return best ? best[0] : sanitizeName(fallback);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Identity of one job's files. A multi-P video has one job per part, so parts 2+ are
 * addressed as `<bvid>-p<part>`; part 1 keeps the plain bvid so audio, transcripts and
 * ASR caches written before parts were split are still found.
 */
function partKey(job) {
  const part = Math.max(1, Number(job.part) || 1);
  return part > 1 ? `${job.bvid}-p${part}` : job.bvid;
}

function transcriptPathFor(job) {
  return job.transcript_path || path.join(config.DATA_DIR, `transcript-${partKey(job)}.json`);
}

function asrCacheDirFor(job) {
  return path.join(config.DATA_DIR, 'asr-cache', partKey(job));
}

/**
 * The transcript exactly as the ASR produced it, before any name replacement. Name
 * corrections are always re-derived from this copy, so changing the name table can
 * never turn a correct spelling back into a wrong one.
 */
function rawTranscriptPathFor(job) {
  return path.join(config.DATA_DIR, `transcript-${partKey(job)}.raw.json`);
}

/** Deep link to one part of a multi-P video. */
function partUrl(url, part) {
  if (part <= 1) return String(url || '');
  const sep = String(url || '').includes('?') ? '&' : '?';
  return `${url}${sep}p=${part}`;
}

module.exports = {
  run, sleep, fmtTime, httpPost, httpGet, sanitizeName, englishName, yyyymmdd, ensureDir, NAME_STOPWORDS,
  partKey, transcriptPathFor, asrCacheDirFor, rawTranscriptPathFor, partUrl,
};
