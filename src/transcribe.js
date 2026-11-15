'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const audio = require('./audio');
const { sleep, fmtTime, httpPost, httpGet, run } = require('./util');

/**
 * Fallback only: the current ASR service reads m4a directly, but older builds answered
 * 500 for anything that is not a WAV file. When an upload is rejected we convert to
 * 16 kHz mono PCM with ffmpeg and retry once. The conversion is written next to the
 * segment so a retry does not re-run ffmpeg, and is removed once the request is done.
 */
async function toWavForAsr(filePath) {
  if (path.extname(filePath).toLowerCase() === '.wav') return filePath;
  const out = filePath.replace(/\.[a-zA-Z0-9]+$/, '') + '.asr.wav';
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  await run(
    config.FFMPEG,
    ['-y', '-v', 'error', '-i', filePath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out],
    { timeout: 5 * 60 * 1000 }
  );
  return out;
}

/** POST a file to the ASR service as multipart/form-data (no npm deps). */
async function postAudio(filePath, signal) {
  const boundary = `----liklo${crypto.randomBytes(16).toString('hex')}`;
  const fileBuf = fs.readFileSync(filePath);
  const ext = path.extname(filePath) || '.audio';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${crypto.randomBytes(4).toString('hex')}${ext}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const tail = Buffer.from(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${config.ASR_MODEL}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n` +
    `--${boundary}--\r\n`
  );

  const res = await httpPost(
    `${config.ASR_BASE}/audio/transcriptions`,
    Buffer.concat([head, fileBuf, tail]),
    {
      Authorization: `Bearer ${config.ASR_API_KEY}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    signal,
    config.ASR_TIMEOUT_MS
  );
  if (res.status !== 200) {
    const e = new Error(`ASR HTTP ${res.status}: ${res.text.slice(0, 400)}`);
    e.status = res.status;
    throw e;
  }
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error(`ASR returned non-JSON: ${res.text.slice(0, 400)}`);
  }
}

async function asrTranscribe(filePath, signal) {
  try {
    return await postAudio(filePath, signal);
  } catch (e) {
    // only a status that means "I cannot read this container" is worth retrying with WAV
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.wav' || ![400, 415, 422, 500].includes(e.status)) throw e;
    console.log(`[asr] ${ext} upload rejected (HTTP ${e.status}), retrying as 16 kHz WAV`);
    const wav = await toWavForAsr(filePath);
    try {
      return await postAudio(wav, signal);
    } finally {
      try {
        fs.unlinkSync(wav);
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * 1 second of a quiet 440 Hz tone, 16 kHz mono 16-bit PCM WAV, built in memory.
 * Used only to check whether the ASR backend actually answers a transcription request.
 */
function probeWav(seconds = 1, rate = 16000) {
  const n = Math.floor(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.sin((2 * Math.PI * 440 * i) / rate) * 8000;
    data.writeInt16LE(Math.round(v), i * 2);
  }
  const header = Buffer.alloc(36); // RIFF header (12) + fmt chunk (8 + 16)
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + 8 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  const chunk = Buffer.alloc(8);
  chunk.write('data', 0);
  chunk.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, chunk, data]);
}

/**
 * The ASR wrapper handles one request at a time. If it is busy with a real segment,
 * a probe would just time out and look like an outage, so check the health endpoint
 * first and report "busy" separately from "unreachable". Different wrappers expose
 * the health endpoint as /healthz or /health, and not all of them report a queue,
 * so missing fields are simply treated as "not busy".
 */
async function asrBusy() {
  const origin = new URL(config.ASR_BASE).origin;
  for (const path of ['/healthz', '/health']) {
    try {
      const res = await httpGet(`${origin}${path}`, {}, 5000);
      if (res.status !== 200) continue;
      const st = JSON.parse(res.text);
      if (st.busy || Number(st.queued) > 0) return true;
      return false;
    } catch {
      /* try the next candidate */
    }
  }
  return false;
}

/**
 * Liveness check: does the ASR service return a transcription for a 1-second clip?
 * Validation errors (400/404) come back in milliseconds, so a timeout here means the
 * request reached the backend and the model never produced output.
 */
async function probeAsr(timeoutMs = config.ASR_PING_TIMEOUT_MS) {
  if (await asrBusy()) {
    return { ok: false, busy: true, elapsed: 0, error: '正在转写其它片段（队列忙），请稍后再试' };
  }
  const boundary = `----liklo${crypto.randomBytes(16).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ping.wav"\r\nContent-Type: audio/wav\r\n\r\n`
    ),
    probeWav(),
    Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${config.ASR_MODEL}\r\n` +
      `--${boundary}--\r\n`
    ),
  ]);
  const started = Date.now();
  try {
    const res = await httpPost(
      `${config.ASR_BASE}/audio/transcriptions`,
      body,
      { Authorization: `Bearer ${config.ASR_API_KEY}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      undefined,
      timeoutMs
    );
    const elapsed = (Date.now() - started) / 1000;
    if (res.status !== 200) {
      return { ok: false, elapsed, status: res.status, error: res.text.slice(0, 300) };
    }
    let json = null;
    try {
      json = JSON.parse(res.text);
    } catch {
      /* non-JSON but a 200 still means the backend answered */
    }
    return { ok: true, elapsed, text: (json && (json.text || '')) || '', chars: ((json && json.text) || '').length };
  } catch (e) {
    return { ok: false, elapsed: (Date.now() - started) / 1000, error: String(e.message || e) };
  }
}

/** Normalize verbose_json into { text, segments: [{start,end,speaker,text}] }. */
function normalizeVerbose(json) {
  const segs = [];
  const raw = json.segments || json.verbose_segments || [];
  for (const s of raw) {
    let start = s.start ?? s.begin ?? s.timestamp?.[0] ?? null;
    let end = s.end ?? s.timestamp?.[1] ?? null;
    if (start == null && Array.isArray(s.timestamp) && s.timestamp.length) start = s.timestamp[0];
    const text = (s.text || '').trim();
    if (!text) continue;
    segs.push({ start, end, speaker: s.speaker ?? null, text });
  }
  const text = (json.text || json.transcript || segs.map((s) => s.text).join(' ')).trim();
  return { text, segments: segs };
}

/**
 * Some ASR wrappers answer with plain text and no per-utterance timestamps. Without any
 * timing at all the LLM has nothing to anchor its [HH:MM:SS] references to and invents
 * them, so invent our own instead: cut the text at sentence boundaries and spread the
 * pieces over the segment window in proportion to their length. Rough, but monotonic and
 * always inside the right 5-minute window, which is enough for a report to point at.
 */
function pseudoSegments(text, offset = 0, duration = 0) {
  const body = String(text || '');
  if (!body || !(duration > 0)) return [];
  const parts = body
    .split(/(?<=[。！？!?])|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.replace(/[^0-9a-zA-Z\u4e00-\u9fff]/g, '').length > 0);
  if (!parts.length) return [];
  const total = parts.reduce((a, s) => a + s.length, 0);
  const out = [];
  let acc = 0;
  for (const s of parts) {
    const start = offset + (duration * acc) / total;
    acc += s.length;
    const end = Math.min(offset + duration, offset + (duration * acc) / total);
    out.push({
      start: Math.round(start * 10) / 10,
      end: Math.round(end * 10) / 10,
      speaker: null,
      text: s,
    });
  }
  return out;
}

/**
 * Clamp a segment's timestamps to the segment window so merged timestamps stay
 * monotonic and inside the original video (the model occasionally emits an
 * end slightly past the audio length or a reversed interval).
 */
function sanitizeSegment(s, offset, duration) {
  const limit = offset + (duration || 0);
  let start = s.start == null ? null : Math.min(Math.max(s.start + offset, 0), limit);
  let end = s.end == null ? null : Math.min(Math.max(s.end + offset, 0), limit);
  if (end != null && start != null && end < start) end = start;
  if (start == null && end != null) start = end;
  return { start, end, speaker: s.speaker ?? null, text: s.text };
}

/**
 * Cheap content fingerprint of a segment file (size + first/last 4 KiB). Used in the ASR
 * cache name so a cached result can never be reused for a different audio that happens
 * to have the same segment index and length.
 */
function segmentFingerprint(file) {
  try {
    const st = fs.statSync(file);
    const h = crypto.createHash('sha1');
    h.update(String(st.size));
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(4096);
      fs.readSync(fd, buf, 0, Math.min(4096, st.size), 0);
      h.update(buf);
      if (st.size > 4096) {
        fs.readSync(fd, buf, 0, 4096, st.size - 4096);
        h.update(buf);
      }
    } finally {
      fs.closeSync(fd);
    }
    return h.digest('hex').slice(0, 12);
  } catch {
    return 'nofingerprint';
  }
}

/**
 * Transcribe a list of segments strictly one at a time (the ASR service is slow),
 * then merge with timeline offsets so timestamps refer to the original video.
 * Each segment result is cached in cacheDir so a cancelled/restarted job does not
 * re-run ASR for segments it already finished.
 */
async function transcribeSegments(segments, onProgress, signal, cacheDir) {
  if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true });
  const mergedText = [];
  const mergedSegments = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (signal?.aborted) throw new Error('cancelled');
    if (onProgress) onProgress(i + 1, segments.length, seg.offset, false);
    const cachePath = cacheDir
      ? path.join(
          cacheDir,
          `seg${String(i + 1).padStart(2, '0')}_${Math.round(seg.duration || 0)}s_${segmentFingerprint(seg.path)}.json`
        )
      : null;
    let norm = null;
    if (cachePath && fs.existsSync(cachePath)) {
      try {
        norm = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        console.log(`[asr] using cached segment ${i + 1}/${segments.length}`);
      } catch {
        norm = null;
      }
    }

    if (!norm) {
      const started = Date.now();
      norm = await transcribeSegment(seg, signal);
      console.log(`[asr] segment ${i + 1}/${segments.length} transcribed in ${((Date.now() - started) / 1000).toFixed(1)}s (${norm.segments.length} segments, ${norm.text.length} chars)`);
      if (cachePath) fs.writeFileSync(cachePath, JSON.stringify(norm), 'utf8');
    }

    if (!norm.segments || !norm.segments.length) {
      const fake = pseudoSegments(norm.text, seg.offset, seg.duration);
      if (fake.length) {
        norm.segments = fake;
        console.log(`[asr] segment ${i + 1}/${segments.length} had no timestamps, synthesised ${fake.length} from text length`);
      }
    }

    if (norm.text) mergedText.push(norm.text);
    for (const s of norm.segments) {
      mergedSegments.push(sanitizeSegment(s, seg.offset, seg.duration));
    }
    // heartbeat after each finished segment so the UI shows real progress/ETA
    if (onProgress) onProgress(i + 1, segments.length, seg.offset, true);
  }
  mergedSegments.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  return { text: mergedText.join('\n'), segments: mergedSegments };
}

/** One segment, with retries and a fallback to smaller sub-segments if the service rejects it. */
async function transcribeSegment(seg, signal) {
  try {
    return normalizeVerbose(await withRetry(seg.path, signal));
  } catch (e) {
    if (signal?.aborted || (seg.duration || 0) <= 320) throw e;
    console.warn(`[asr] ${path.basename(seg.path)} failed (${e.message}); retrying as 5-minute sub-segments`);
    const parts = await audio.splitAudio(seg.path, 300);
    const text = [];
    const segs = [];
    for (const p of parts) {
      const n = normalizeVerbose(await withRetry(p.path, signal));
      if (n.text) text.push(n.text);
      for (const s of n.segments) {
        segs.push(sanitizeSegment(s, p.offset, p.duration));
      }
    }
    return { text: text.join('\n'), segments: segs };
  }
}

async function withRetry(filePath, signal) {
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    try {
      return await asrTranscribe(filePath, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (attempt >= config.ASR_MAX_RETRIES) {
        throw new Error(`ASR ${path.basename(filePath)} failed after ${secs}s: ${e.message}`);
      }
      console.error(`[asr] ${path.basename(filePath)} attempt ${attempt + 1} failed after ${secs}s: ${e.message}; retrying`);
      await sleep(5000 * (attempt + 1));
    }
  }
}

/**
 * ASR writes placeholders and single backchannels for stretches where nobody speaks:
 * "[音乐]", "[S01]", "嗯", "对对对". Kept in the timeline they do two kinds of damage:
 * the model has to describe a window in which nothing happened, and every one of those
 * lines costs prompt tokens. A line counts as speech only if it carries real content.
 * The threshold is deliberately low (two characters) so "谢谢" survives and pure noise
 * does not.
 */
const MIN_SPEECH_CHARS = 2;
const SILENCE_SECONDS = 60;

/** Tokens ASR emits for "something other than speech happened here", including the
 *  truncated timing artifacts of verbose output ("[0.00]Música[300"). Accents are
 *  stripped first so "Música" and "music" are the same token. */
const NON_SPEECH_TOKEN = /^(music.*|bgm|\d+|音乐|背景音乐|s\d+|silence|no[- ]?speech)$/i;

function speechChars(segment) {
  const text = String((segment && segment.text) || '')
    // ASR placeholders and timing markers: "[S01]", "[0.00]", "[音乐]"
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\[[^\]]*/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^一-龥a-zA-Z0-9]+/g, ' ');
  return text
    .split(' ')
    .filter((w) => w && !NON_SPEECH_TOKEN.test(w))
    .join('')
    .length;
}

function hasSpeech(segment) {
  return speechChars(segment) >= MIN_SPEECH_CHARS;
}

/** MM:SS, or H:MM:SS for stretches past an hour. Deliberately not HH:MM:SS: the
 *  section-range parser looks for full timestamps and must not treat a silence marker
 *  as the start of a section. */
function fmtSpan(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

function silenceMarker(start, end) {
  return `[静默段 ${fmtSpan(start)} 至 ${fmtSpan(end)} 无人说话]`;
}

/** End of the stream. The transcript file does not always carry a duration, so the
 *  last segment is the fallback. */
function streamEndOf(transcript, segments) {
  const d = Number(transcript.duration) || 0;
  if (d > 0) return d;
  let end = 0;
  for (const s of segments) end = Math.max(end, Number(s.end) || Number(s.start) || 0);
  return end;
}

/** Build a timestamped transcript timeline for the LLM prompt. */
function buildTimeline(transcript) {
  const segments = (transcript.segments || []).filter((s) => s.start != null);
  if (!segments.length) return transcript.text || '';
  const out = [];
  // the stream starts with no transcript line until the first one: that stretch is
  // silence like any gap between two lines, so the counter starts at 0
  let silentFrom = 0;
  const streamEnd = streamEndOf(transcript, segments);
  for (const s of segments) {
    if (hasSpeech(s)) {
      if (silentFrom != null && Number(s.start) - silentFrom >= SILENCE_SECONDS) {
        out.push(silenceMarker(silentFrom, Number(s.start)));
      }
      silentFrom = null;
      out.push(`[${fmtTime(s.start)}] ${s.text}`);
    } else if (silentFrom == null) {
      silentFrom = Number(s.start);
    }
  }
  // a stream that ends with nobody speaking: keep the fact, not the placeholder lines
  if (silentFrom != null && streamEnd - silentFrom >= SILENCE_SECONDS) {
    out.push(silenceMarker(silentFrom, streamEnd));
  }
  return out.join('\n');
}

/** When the first line of actual speech is, or null when the transcript has none. */
function firstSpeechSeconds(transcript) {
  for (const s of transcript.segments || []) {
    if (s.start != null && hasSpeech(s)) return Number(s.start);
  }
  return null;
}

module.exports = {
  asrTranscribe,
  transcribeSegments,
  buildTimeline,
  normalizeVerbose,
  pseudoSegments,
  probeAsr,
  probeWav,
  hasSpeech,
  firstSpeechSeconds,
  silenceMarker,
  SILENCE_SECONDS,
};
