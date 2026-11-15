'use strict';

// shared helpers used by both index.html (task list) and reports.html (report library)

const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 6000);
}

/** Per-streamer tag colours, the same rule as the static export: the two regulars are
 *  coloured explicitly, everyone else gets a hue derived from the name, so a new
 *  streamer is coloured automatically and the same name always looks the same. */
const PERSONA_COLORS = {
  莉蔻: 'background:#fff0e0;color:#8f4c14;border-color:#e3b481', // 橘黄
  liko: 'background:#fff0e0;color:#8f4c14;border-color:#e3b481',
  克罗雅: 'background:#f2dde5;color:#7b2c46;border-color:#d6a9bd', // 暗粉
  kloa: 'background:#f2dde5;color:#7b2c46;border-color:#d6a9bd',
};

function personaKey(name) {
  const cjk = String(name || '').match(/[\u4e00-\u9fa5]{2,}/);
  return (cjk ? cjk[0] : String(name || '')).toLowerCase();
}

function personaStyle(name) {
  const key = personaKey(name);
  const latin = (String(name || '').toLowerCase().match(/[a-z]+/g) || []).join('');
  for (const [known, style] of Object.entries(PERSONA_COLORS)) {
    if (key === known || latin === known || key.includes(known) || latin.includes(known)) return style;
  }
  let h = 0;
  for (const ch of key) h = (h * 131 + ch.codePointAt(0)) % 360;
  return `background:hsl(${h},45%,93%);color:hsl(${h},52%,26%);border-color:hsl(${h},40%,72%)`;
}

function personaTag(name) {
  if (!name) return '';
  return `<span class="tag persona" style="${personaStyle(name)}">${esc(name)}</span>`;
}

function fmtDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}小时${m}分` : `${m}分${s}秒`;
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** name corrections recorded by src/names.js: JSON [{wrong, correct, count}] */
function parseFixes(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter((f) => f && f.wrong && f.correct) : [];
  } catch {
    return [];
  }
}

function fixesHtml(fixes) {
  if (!fixes.length) return '';
  return (
    '<div class="fixes"><span class="mid">已自动修正人名</span>' +
    fixes.map((f) => `<span class="tag on">${esc(f.wrong)} → ${esc(f.correct)} ×${f.count || 1}</span>`).join('') +
    '</div>'
  );
}

/**
 * Deep link to a B站 video at a given second.
 * `t=` is what the web player reads; `start_progress=` (milliseconds) is what the
 * mobile app reads, so both PC and phone jump to the same moment.
 */
function videoLink(url, seconds) {
  if (!url) return '';
  const sec = Math.max(0, Math.floor(Number(seconds) || 0));
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}t=${sec}&start_progress=${sec * 1000}`;
}

/** Minimal Markdown -> HTML, turning HH:MM:SS into links to the source video. */
function renderMarkdown(md, sourceUrl) {
  const escape = esc;
  const linkify = (text) =>
    text.replace(/(\d{1,2}):(\d{2}):(\d{2})/g, (m, h, mi, s) => {
      const sec = Number(h) * 3600 + Number(mi) * 60 + Number(s);
      return sourceUrl ? `<a class="ts" href="${esc(videoLink(sourceUrl, sec))}" target="_blank">${m}</a>` : `<code>${m}</code>`;
    });

  const lines = String(md || '').split(/\r?\n/);
  const out = [];
  let listOpen = false;

  const inline = (t) =>
    escape(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (listOpen) { out.push('</ul>'); listOpen = false; }
      continue;
    }
    const h = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      if (listOpen) { out.push('</ul>'); listOpen = false; }
      const level = Math.min(h[1].length + 1, 4);
      out.push(`<h${level}>${linkify(inline(h[2]))}</h${level}>`);
      continue;
    }
    const li = trimmed.match(/^[-*+]\s+(.*)$/);
    if (li) {
      if (!listOpen) { out.push('<ul>'); listOpen = true; }
      out.push(`<li>${linkify(inline(li[1]))}</li>`);
      continue;
    }
    if (listOpen) { out.push('</ul>'); listOpen = false; }
    out.push(`<p>${linkify(inline(trimmed))}</p>`);
  }
  if (listOpen) out.push('</ul>');
  return out.join('\n');
}

/**
 * ASR fills stretches where nobody speaks with placeholders and single backchannels
 * ("[音乐]", "[S01]", "嗯"). The same rule as src/transcribe.js: a line counts as
 * speech only if it carries real content, and a gap of more than a minute is shown as
 * one silence row instead of a wall of empty rows.
 */
const MIN_SPEECH_CHARS = 2;
const SILENCE_SECONDS = 60;
const NON_SPEECH_TOKEN = /^(music.*|bgm|\d+|音乐|背景音乐|s\d+|silence|no[- ]?speech)$/i;

function isSpeech(s) {
  const text = String((s && s.text) || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\[[^\]]*/g, ' ')
    // "Música" and "music" are the same token
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^一-龥a-zA-Z0-9]+/g, ' ');
  return text.split(' ').filter((w) => w && !NON_SPEECH_TOKEN.test(w)).join('').length >= MIN_SPEECH_CHARS;
}

function span(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

function silenceRow(base, from, to) {
  const link = base
    ? `<a class="ts" href="${esc(videoLink(base, from))}">${fmtTime(from)}</a>`
    : `<span class="ts">${fmtTime(from)}</span>`;
  return `<div class="tl-row silence">${link}<span class="tl-text">静默 ${span(from)} – ${span(to)}（无人说话）</span></div>`;
}

/** Timestamped transcript -> clickable timeline rows (used by both pages). */
function renderTimeline(t) {
  const data = Array.isArray(t) ? { segments: t } : t;
  const all = (data.segments || []).filter((s) => s.start != null);
  if (!all.length) return `<pre>${esc(data.text || '')}</pre>`;
  const base = data.url || '';
  const rows = [];
  // the stream starts with no transcript line until the first one: that stretch is
  // silence like any gap between two rows, so the counter starts at 0
  let silentFrom = 0;
  for (const s of all) {
    if (isSpeech(s)) {
      if (silentFrom != null && Number(s.start) - silentFrom >= SILENCE_SECONDS) {
        rows.push(silenceRow(base, silentFrom, Number(s.start)));
      }
      silentFrom = null;
      const ts = fmtTime(s.start);
      const link = base
        ? `<a class="ts" href="${esc(videoLink(base, s.start))}" target="_blank">${ts}</a>`
        : `<span class="ts">${ts}</span>`;
      const speaker = s.speaker ? `<span class="speaker">${esc(s.speaker)}</span>` : '';
      rows.push(`<div class="tl-row">${link}${speaker}<span class="tl-text">${esc(s.text)}</span></div>`);
    } else if (silentFrom == null) {
      silentFrom = Number(s.start);
    }
  }
  const end = Number(data.duration) || 0;
  if (silentFrom != null && end - silentFrom >= SILENCE_SECONDS) rows.push(silenceRow(base, silentFrom, end));
  return rows.join('\n');
}
