'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function env(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

const DATA_DIR = env('LIKLO_DATA', path.join(ROOT, 'data'));

const config = {
  ROOT,
  PORT: Number(env('LIKLO_PORT', '3200')), // 3000 is used by the sibling audio-world app

  // read-only report library exposed to other people (no editing, no job control)
  PUBLIC_PORT: Number(env('LIKLO_PUBLIC_PORT', '3210')),
  // 0.0.0.0 so the page can be reached from outside the LAN (firewall/port forward
  // has to allow it); use 127.0.0.1 to keep it local only.
  PUBLIC_HOST: env('LIKLO_PUBLIC_HOST', '0.0.0.0'),

  // self-contained static export of the report library (upload the folder to any
  // static host). SITE_PORT is only the local preview server started by the
  // 「生成静态报告库」 button; a static host decides its own port.
  SITE_DIR: env('LIKLO_SITE_DIR', path.join(ROOT, 'liklo-site')),
  SITE_PORT: Number(env('LIKLO_SITE_PORT', '3120')),

  // local tooling
  YTDLP: env('LIKLO_YTDLP', path.join(ROOT, 'runtime', 'yt-dlp.exe')),
  FFMPEG: env('LIKLO_FFMPEG', path.join(ROOT, 'runtime', 'ffmpeg.exe')),
  FFPROBE: env('LIKLO_FFPROBE', path.join(ROOT, 'runtime', 'ffprobe.exe')),
  // B站 cookies are used by every API request in src/bilibili.js and by yt-dlp.
  // A cookies.txt imported from the page is rewritten to data/cookies.txt; when that
  // file exists it is the active jar, so an import survives restarts without env vars.
  COOKIE_DEFAULT: env('LIKLO_COOKIE', path.join(ROOT, 'cookies.txt')),
  COOKIE_STORE: env('LIKLO_COOKIE_STORE', path.join(DATA_DIR, 'cookies.txt')),

  // ASR service: MOSS-Transcribe-Diarize (cpp engine, CPU) served by the local
  // OpenAI-compatible wrapper. The wrapper ignores the `model` field, it is only
  // shown in the UI, so keep it as the id the service reports.
  ASR_BASE: env('ASR_BASE', 'http://127.0.0.1:8000/v1'),
  ASR_API_KEY: env('ASR_API_KEY', ''),
  ASR_MODEL: env('ASR_MODEL', 'MOSS-Transcribe-Diarize-q5'),
  // hard ceiling for one ASR request; without it a stuck service blocks the queue forever.
  // measured on the 16-core box (.126, q5_k): RTF < 1, so a 300 s segment takes a few
  // minutes; the ceiling stays generous so a slow machine never times out mid-segment.
  ASR_TIMEOUT_MS: Number(env('ASR_TIMEOUT_MS', '2400000')), // 40 min per segment
  ASR_MAX_RETRIES: Number(env('ASR_MAX_RETRIES', '3')),
  // short liveness probe used by /api/services-status so a stuck backend is
  // reported quickly instead of blocking a job for 40 minutes
  ASR_PING_TIMEOUT_MS: Number(env('ASR_PING_TIMEOUT_MS', '60000')),

  // local LLM
  LLM_BASE: env('LLM_BASE', 'http://127.0.0.1:8080/v1'),
  LLM_API_KEY: env('LLM_API_KEY', ''),
  LLM_MODEL: env('LLM_MODEL', 'qwen3.8-flash-next-q2_0'),
  LLM_TIMEOUT_MS: Number(env('LLM_TIMEOUT_MS', '600000')),
  // 0 = detect the real window from the LLM server (GET /props -> n_ctx).
  // set a number to pin it (useful when the server has a smaller window).
  LLM_MAX_CONTEXT: Number(env('LLM_MAX_CONTEXT', '0')),

  // pipeline
  MAX_SEGMENT_SECONDS: Number(env('MAX_SEGMENT_SECONDS', '300')), // 5 min per ASR request (15 min is too slow / times out)
  // multi-part videos: 'first' (default) downloads and transcribes only P1, 'all'
  // concatenates every part. Most B站 multi-P replays are the same stream published
  // twice (弹幕版 / 纯净版) or split in halves, so P1 is the whole show and transcribing
  // the rest only doubles the (very slow) ASR time. Override per job with allParts=true.
  MULTI_P: env('LIKLO_MULTI_P', 'first'),
  MONITOR_INTERVAL_MS: Number(env('MONITOR_INTERVAL_MS', String(10 * 60 * 1000))),
  // replays found per UP per pass: a channel that streams daily queues up to this
  // many instead of one per 10 minutes
  MONITOR_LIMIT: Number(env('MONITOR_LIMIT', '3')),
  // collections are only opened when their title relates to the streamer; when
  // none do, at most this many are scanned
  MONITOR_MAX_SEASONS: Number(env('MONITOR_MAX_SEASONS', '6')),
  // uploads shorter than this are treated as clips, not 直播 (used by the
  // date-pattern heuristic in src/bilibili.js isReplay)
  MIN_REPLAY_SECONDS: Number(env('MIN_REPLAY_SECONDS', '1200')),

  DATA_DIR,
  UA: env('LIKLO_UA', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'),
};

config.DOWNLOAD_DIR = path.join(config.DATA_DIR, 'audio');
config.DB_PATH = path.join(config.DATA_DIR, 'liklo.db');

// the imported jar wins over the external default; nothing else has to be configured
config.COOKIE_FILE = fs.existsSync(config.COOKIE_STORE) ? config.COOKIE_STORE : config.COOKIE_DEFAULT;

// ---------- service settings editable from the page ----------
// Anything saved through the 「服务配置」 card is written to data/settings.json and
// wins over the defaults above (and over env vars), so changing the ASR/LLM address
// does not require restarting with different environment variables.
const SERVICE_KEYS = [
  'ASR_BASE', 'ASR_API_KEY', 'ASR_MODEL', 'ASR_TIMEOUT_MS', 'ASR_PING_TIMEOUT_MS', 'ASR_MAX_RETRIES',
  'LLM_BASE', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_TIMEOUT_MS', 'LLM_MAX_CONTEXT',
];
config.SETTINGS_FILE = env('LIKLO_SETTINGS', path.join(DATA_DIR, 'settings.json'));

// snapshot of the built-in/env defaults so the page can restore them
const DEFAULTS = Object.fromEntries(SERVICE_KEYS.map((k) => [k, config[k]]));

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(config.SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

// keep only known keys, coerce numbers, drop empty strings
function normalizeSettings(raw) {
  const out = {};
  for (const key of SERVICE_KEYS) {
    const v = raw[key];
    if (v === undefined || v === null || String(v).trim() === '') continue;
    if (key.endsWith('_MS') || key === 'ASR_MAX_RETRIES') {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[key] = n;
    } else {
      out[key] = String(v).trim();
    }
  }
  return out;
}

function applySettings(raw) {
  for (const [key, value] of Object.entries(normalizeSettings(raw))) config[key] = value;
}

config.currentSettings = () => Object.fromEntries(SERVICE_KEYS.map((k) => [k, config[k]]));
config.defaults = () => ({ ...DEFAULTS });

config.saveSettings = (updates) => {
  const merged = { ...readSettings(), ...normalizeSettings(updates || {}) };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(config.SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf8');
  applySettings(merged);
  return config.currentSettings();
};

// delete the override file and go back to the built-in defaults
config.resetSettings = () => {
  try {
    fs.unlinkSync(config.SETTINGS_FILE);
  } catch {
    /* nothing saved yet */
  }
  for (const key of SERVICE_KEYS) config[key] = DEFAULTS[key];
  return config.currentSettings();
};

applySettings(readSettings());

module.exports = config;
