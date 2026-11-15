#!/usr/bin/env node
'use strict';
/*
 * moss-api.js — OpenAI-compatible HTTP wrapper around the moss-transcribe.cpp CLI.
 *
 *   POST /v1/audio/transcriptions   multipart form: file (+ model, response_format)
 *   GET  /v1/models
 *   GET  /healthz
 *
 * response_format: verbose_json (default) | json | text | srt
 * verbose_json => { id, language, text, segments: [{id,start,end,text,speaker}] }
 *
 * Any audio format ffmpeg can read is accepted; the moss CLI only reads WAV,
 * so non-WAV uploads are converted to 16 kHz mono WAV first.
 * Requests are handled strictly one at a time (the model is single-instance).
 *
 * Robustness notes:
 *  - if the client goes away (cancelled job / aborted request) the running CLI
 *    child is killed, so the queue never stays "busy" behind a dead request;
 *  - readBody() resolves on 'close' too, so a half-read upload cannot deadlock;
 *  - a watchdog clears a stuck busy flag as a last resort.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');

const CLI = process.env.MT_CLI || '/root/moss-transcribe.cpp/build/moss-transcribe';
const MODEL = process.env.MT_MODEL || '/root/models/moss-transcribe-q5_0.gguf';
const MODEL_NAME = process.env.MT_MODEL_NAME || 'moss-transcribe-cpp-0.9b';
const PORT = Number(process.env.PORT || 8100);
const THREADS = process.env.MTD_THREADS || String(Math.max(1, os.cpus().length));
const REQ_TIMEOUT_MS = Number(process.env.MT_TIMEOUT_MS || 3600000);
const MAX_UPLOAD_BYTES = Number(process.env.MT_MAX_UPLOAD || 200 * 1024 * 1024);
const WORK_DIR = process.env.MT_WORK_DIR || '/tmp/moss-api';
const API_KEY = process.env.MT_API_KEY || ''; // empty = no auth check

fs.mkdirSync(WORK_DIR, { recursive: true });

function log(...a) {
  console.log(`[${new Date().toISOString()}]`, ...a);
}

/* ---------------- multipart parsing ---------------- */
function parseMultipart(buf, boundary) {
  const parts = [];
  const delim = Buffer.from('--' + boundary);
  let idx = buf.indexOf(delim);
  while (idx !== -1) {
    let start = idx + delim.length;
    if (buf.slice(start, start + 2).toString() === '--') break; // closing delimiter
    if (buf[start] === 0x0d) start += 2; // skip CRLF after delimiter
    const headerEnd = buf.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;
    const headers = buf.slice(start, headerEnd).toString('utf8');
    const contentStart = headerEnd + 4;
    let next = buf.indexOf(delim, contentStart);
    if (next === -1) next = buf.length;
    let contentEnd = next;
    if (contentEnd >= 2 && buf.slice(contentEnd - 2, contentEnd).toString() === '\r\n') contentEnd -= 2;
    parts.push({ headers, body: buf.slice(contentStart, contentEnd) });
    idx = next;
  }
  return parts;
}

function fieldName(headers) {
  const m = /name="([^"]+)"/i.exec(headers);
  return m ? m[1] : null;
}

function fileName(headers) {
  const m = /filename="([^"]*)"/i.exec(headers);
  return m ? m[1] : '';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD_BYTES) {
        reject(new Error(`upload too large (${size} bytes > ${MAX_UPLOAD_BYTES})`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    // 'close' fires for aborted connections too: resolve with whatever arrived
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('close', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ---------------- audio helpers ---------------- */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (opts.onChild) opts.onChild(p);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d.toString('utf8')));
    p.stderr.on('data', (d) => (err += d.toString('utf8')));
    const timer = opts.timeoutMs
      ? setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${path.basename(cmd)} timed out after ${opts.timeoutMs} ms`)); }, opts.timeoutMs)
      : null;
    p.on('close', (code) => {
      if (timer) clearTimeout(timer);
      // killed because the client went away: not an error, just stop working
      if (p.killed) resolve('');
      else if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(cmd)} exited ${code}: ${err.slice(0, 500)}`));
    });
    p.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
  });
}

function audioDuration(filePath) {
  // ffprobe is available with the ffmpeg package
  return run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath])
    .then((s) => Number(s.trim()))
    .catch(() => 0);
}

/* ---------------- transcript parsing ---------------- */
/** Fallback parser for the raw `[start][Sxx]text[end]` stream. */
function parseRawStream(raw) {
  const segments = [];
  const re = /\[(\d+(?:\.\d+)?)\]\[S(\d+)\]([\s\S]*?)\[(\d+(?:\.\d+)?)\]/g;
  let m;
  while ((m = re.exec(raw))) {
    const text = m[3].trim();
    if (!text) continue;
    segments.push({ start: Number(m[1]), end: Number(m[4]), speaker: 'S' + m[2], text });
  }
  return segments;
}

/**
 * The CLI `--format json` prints a bare array of
 *   {id, start, end, speaker, text}
 * (seconds, relative to the audio that was fed in). Accept that, plus the
 * object-shaped variants, and fall back to the raw `[start][Sxx]text[end]` stream.
 */
function toSegments(cliJson, rawText) {
  let arr = null;
  if (Array.isArray(cliJson)) arr = cliJson;
  else if (cliJson && Array.isArray(cliJson.segments)) arr = cliJson.segments;

  if (arr) {
    const out = arr
      .map((s) => ({
        start: Number(s.start ?? s.begin ?? 0),
        end: Number(s.end ?? s.timestamp?.[1] ?? 0),
        speaker: s.speaker || s.speaker_name || null,
        text: String(s.text || '').trim(),
      }))
      .filter((s) => s.text);
    if (out.length) return out;
  }
  return parseRawStream(rawText || '');
}

function toText(segments) {
  return segments.map((s) => s.text).join('\n').trim();
}

function formatTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const cs = Math.floor((sec % 60) * 100);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')},${String(cs).padStart(2, '0')}`;
}

function toSrt(segments) {
  return segments
    .map((s, i) => `${i + 1}\n${formatTime(s.start)} --> ${formatTime(s.end)}\n${s.text}\n`)
    .join('\n');
}

/* ---------------- request handling ---------------- */
let busy = false;
let busySince = 0;
let currentChild = null;
const queue = [];

function killCurrentChild(reason) {
  if (!currentChild) return;
  try {
    currentChild.killed = true;
    currentChild.kill('SIGKILL');
    log(`killed running transcription (${reason})`);
  } catch { /* ignore */ }
  currentChild = null;
}

async function handleTranscription(req, res, startedAt) {
  const ct = req.headers['content-type'] || '';
  const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (!bm) return send(res, 400, { error: { message: 'expected multipart/form-data' } });
  const body = await readBody(req);
  const parts = parseMultipart(body, bm[1] || bm[2]);
  if (!parts.length) return send(res, 400, { error: { message: 'missing or invalid "file"' } });

  let fileBuf = null;
  let filename = 'audio';
  let responseFormat = 'verbose_json';
  for (const p of parts) {
    const name = fieldName(p.headers);
    if (name === 'file') {
      fileBuf = p.body;
      filename = fileName(p.headers) || 'audio';
    } else if (name === 'response_format') {
      responseFormat = p.body.toString('utf8').trim() || 'verbose_json';
    }
  }
  if (!fileBuf || !fileBuf.length) return send(res, 400, { error: { message: 'missing or invalid "file"' } });

  const id = crypto.randomBytes(8).toString('hex');
  const ext = (path.extname(filename) || '.bin').toLowerCase();
  const inPath = path.join(WORK_DIR, `${id}${ext}`);
  fs.writeFileSync(inPath, fileBuf);

  let wavPath = inPath;
  try {
    if (ext !== '.wav') {
      wavPath = path.join(WORK_DIR, `${id}.wav`);
      await run('ffmpeg', ['-y', '-v', 'error', '-i', inPath, '-ac', '1', '-ar', '16000', '-f', 'wav', wavPath]);
    }
    const duration = await audioDuration(wavPath);
    const maxNew = Math.min(16000, Math.max(1024, Math.ceil((duration || 60) * 40)));
    const env = { MTD_THREADS: THREADS };
    const out = await run(
      CLI,
      ['transcribe', MODEL, wavPath, '--max-new', String(maxNew), '--format', 'json'],
      { env, timeoutMs: REQ_TIMEOUT_MS, onChild: (p) => (currentChild = p) }
    );
    currentChild = null;
    let cliJson = null;
    try {
      cliJson = JSON.parse(out);
    } catch {
      cliJson = null;
    }
    const raw = cliJson && typeof cliJson.text === 'string'
      ? cliJson.text
      : Array.isArray(cliJson) ? '' : out;
    const segments = toSegments(cliJson, raw);
    const text = toText(segments) || String(raw || '').trim();
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(`done ${filename} (${duration}s audio) -> ${segments.length} segments, ${text.length} chars in ${elapsed}s`);

    if (responseFormat === 'text') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(text);
      return;
    }
    if (responseFormat === 'srt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(toSrt(segments));
      return;
    }
    send(res, 200, {
      id,
      object: 'response',
      model: MODEL_NAME,
      language: 'zh',
      duration: duration,
      elapsed: Number(elapsed),
      text,
      segments: segments.map((s, i) => ({
        id: s.id || `seg_${String(i + 1).padStart(4, '0')}`,
        start: s.start,
        end: s.end,
        text: s.text,
        speaker: s.speaker,
      })),
    });
  } catch (e) {
    log(`error on ${filename}: ${e.message}`);
    send(res, 500, { error: { message: e.message } });
  } finally {
    currentChild = null;
    for (const f of [inPath, wavPath]) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function authorized(req) {
  if (!API_KEY) return true;
  const h = req.headers.authorization || '';
  return h.replace(/^Bearer\s+/i, '') === API_KEY;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/health')) {
    return send(res, 200, { status: 'ok', model: MODEL_NAME, busy, queued: queue.length, busySeconds: busy ? Math.round((Date.now() - busySince) / 1000) : 0 });
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    if (!authorized(req)) return send(res, 401, { error: { message: 'An authentication key is required' } });
    return send(res, 200, { object: 'list', data: [{ id: MODEL_NAME, object: 'model' }] });
  }
  if (req.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
    if (!authorized(req)) return send(res, 401, { error: { message: 'An authentication key is required' } });
    // client gone -> stop burning CPU on a response nobody will read
    res.on('close', () => {
      if (!res.writableEnded) killCurrentChild('client disconnected');
    });
    queue.push({ req, res });
    drain();
    return;
  }
  send(res, 404, { error: { message: 'not found: ' + url.pathname } });
});

function drain() {
  if (busy) return;
  const next = queue.shift();
  if (!next) return;
  busy = true;
  busySince = Date.now();
  const startedAt = Date.now();
  handleTranscription(next.req, next.res, startedAt)
    .catch((e) => {
      log('unhandled:', e.message);
      try { send(next.res, 500, { error: { message: e.message } }); } catch { /* ignore */ }
    })
    .finally(() => {
      busy = false;
      busySince = 0;
      currentChild = null;
      drain();
    });
}

// last-resort watchdog: a stuck request must not block the queue forever
setInterval(() => {
  if (busy && Date.now() - busySince > REQ_TIMEOUT_MS + 120000) {
    log('watchdog: clearing stuck request');
    killCurrentChild('watchdog');
    busy = false;
    busySince = 0;
    drain();
  }
}, 10000);

server.listen(PORT, '0.0.0.0', () => log(`moss-api listening on 0.0.0.0:${PORT} (cli=${CLI}, model=${MODEL}, threads=${THREADS})`));
