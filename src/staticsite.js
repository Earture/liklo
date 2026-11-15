'use strict';
/*
 * Static export of the report library.
 *
 * Everything needed to put the report library on a plain static host (GitHub Pages,
 * Cloudflare Pages, nginx, object storage, ...) is written into config.SITE_DIR:
 *
 *   index.html              report library front page (sorted by the stream date
 *                           found in the title, with a search box and a sort menu)
 *   reports/BVxxxx.html     one page per report: full report + timestamped transcript
 *   markdown/BVxxxx.md      the raw Markdown, still downloadable from the page
 *   assets/style.css        styles (copied from public/style.css + a little extra)
 *   assets/site.js          the search box and the time sort on the front page
 *   assets/title.webp       the title banner from the project root, scaled down and
 *                           re-encoded, shown centered at the top of every page
 *   README.md               how to deploy
 *
 * The HTML is produced with the renderer the admin pages use (public/common.js), so
 * timestamp links keep both `t=` (PC web player) and `start_progress=` (mobile app).
 * No server, no API, no build step: the exported folder is self-contained.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const config = require('./config');
const db = require('./db');
const { transcriptPathFor, partKey } = require('./util');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// The title banner is a file in the project root. It is copied into the export so
// the exported folder stays self-contained, and rendered centered at the very top
// of every page. Missing file -> no banner, the pages still work.
const TITLE_IMAGE = '静态网站标题图.png';
// The root image is a 2172x724 PNG (3.5 MB); a page is at most 960px wide, so the
// banner is scaled down and re-encoded as WebP before it is shipped.
const HERO_WIDTH = Number(process.env.LIKLO_SITE_HERO_WIDTH || '1200');

// public/common.js is a browser script, but its helpers are plain functions, so the
// same code can be reused here. That keeps the exported pages byte-for-byte identical
// to what the admin UI renders.
function renderer() {
  const src = fs.readFileSync(path.join(config.ROOT, 'public', 'common.js'), 'utf8');
  const load = new Function(
    src + '\nreturn { renderMarkdown, renderTimeline, fmtDuration, fmtTime, esc, videoLink };'
  );
  return load();
}

/** one file name per job; parts of a multi-P video are `<bvid>-p2` etc. */
function slug(r) {
  const s = partKey(r).replace(/[^A-Za-z0-9_-]/g, '');
  return s || 'job-' + r.id;
}

// set by build() when the root has a title banner; null means "no banner"
let titleImage = null;

/** Copy the root title banner into assets/, compressed for the web, and remember it.
 * No file -> no banner. If ffmpeg is unavailable the original PNG is copied instead. */
function copyTitleImage(dir) {
  const src = path.join(config.ROOT, TITLE_IMAGE);
  if (!fs.existsSync(src)) {
    titleImage = null;
    return null;
  }
  const webp = path.join(dir, 'assets', 'title.webp');
  // re-encode only when the source changed, so re-running the export is cheap
  const fresh = fs.existsSync(webp) && fs.statSync(webp).size > 0 && fs.statSync(webp).mtimeMs > fs.statSync(src).mtimeMs;
  if (!fresh) {
    try {
      spawnSync(config.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', src, '-vf', `scale=${HERO_WIDTH}:-1`, '-quality', '82', webp], { windowsHide: true });
    } catch {
      /* fall back to the original file below */
    }
    if (!fs.existsSync(webp) || !fs.statSync(webp).size) {
      fs.copyFileSync(src, path.join(dir, 'assets', 'title.png'));
      titleImage = 'title.png';
      return titleImage;
    }
  }
  titleImage = 'title.webp';
  const stalePng = path.join(dir, 'assets', 'title.png');
  if (fs.existsSync(stalePng)) fs.unlinkSync(stalePng);
  return titleImage;
}

/** The banner at the very top of a page, centered. `assetsPrefix` is the same one
 * the page's stylesheet link uses, so report pages point at ../assets/. */
function heroHtml(alt, assetsPrefix) {
  if (!titleImage) return '';
  return `<div class="hero"><img src="${assetsPrefix}${titleImage}" alt="${escAttr(alt)}" /></div>`;
}

function escAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// DB timestamps are UTC; show them in local time like the admin pages do
function localTime(utc) {
  if (!utc) return '';
  const d = new Date(String(utc).replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? String(utc) : d.toLocaleString();
}

/** Unix seconds of a report, for the "when was it generated" sort. */
function sortTime(r) {
  const d = new Date(String(r.updated_at || r.created_at || '').replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000);
}

/**
 * The stream date written in the title, e.g.
 *   莉蔻Liko 睡醒咯~ (2026-10-11直播录像)
 *   克罗雅Kloa 一起玩饥荒~ 2026-11-15 16_23_58 直播录像
 *   【克罗雅Kloa】【弹幕】早安上海第一天！— 26.10.16直播回放
 * Returns { stamp: 20261011, ts: unix seconds, label: '2026-10-11' } or null when
 * the title has no date. A two-digit year (26.10.16) is only read as 2026 when the
 * number sits next to 直播/录播/回放, so random numbers are not mistaken for dates.
 */
function liveDate(r) {
  const title = String(r.title || '');
  for (const re of [
    /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/,
    /(\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/,
  ]) {
    const m = title.match(re);
    if (!m) continue;
    let y = Number(m[1]);
    const mo = Number(m[2]), d = Number(m[3]);
    if (y < 100) {
      const near = title.slice(m.index, m.index + m[0].length + 14) + title.slice(Math.max(0, m.index - 14), m.index);
      if (!/直播|录播|回放|录像|live/i.test(near)) continue;
      y += 2000;
    }
    if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    // an optional HH_MM / HH:MM right after the date is the stream start time
    const hm = title.slice(m.index + m[0].length).match(/^[\s-]*?(\d{1,2})[:_](\d{2})/);
    const hh = hm ? Math.min(23, Number(hm[1])) : 0;
    const mm = hm ? Math.min(59, Number(hm[2])) : 0;
    // the title's time is local (UTC+8); convert to UTC so sorts are comparable
    return {
      stamp: y * 10000 + mo * 100 + d,
      label: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}${hm ? ' ' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') : ''}`,
      ts: Math.floor(Date.UTC(y, mo - 1, d, hh - 8, mm) / 1000),
    };
  }
  return null;
}

/**
 * Each persona gets its own tag colour. Names that are known to the user are
 * coloured explicitly (莉蔻 orange, 克罗雅 dark pink); everything else gets a hue
 * derived from the name, so a new streamer is coloured automatically and the same
 * name always looks the same.
 */
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

function loadTimeline(job) {
  const tp = transcriptPathFor(job);
  if (tp && fs.existsSync(tp)) {
    try {
      const t = JSON.parse(fs.readFileSync(tp, 'utf8'));
      return {
        url: job.url,
        duration: t.duration || job.duration || 0,
        segments: t.segments || [],
        text: t.text || job.transcript || '',
      };
    } catch {
      /* fall through to the stored plain text */
    }
  }
  if (job.transcript) return { url: job.url, duration: job.duration || 0, segments: [], text: job.transcript };
  return null;
}

function pageShell(title, body, assetsPrefix) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <link rel="stylesheet" href="${assetsPrefix}style.css" />
</head>
<body>
${body}
</body>
</html>
`;
}

function reportPage(r, render) {
  const esc = render.esc;
  const job = db.getJob(r.id);
  const timeline = job ? loadTimeline(job) : null;
  const file = slug(r);
  const title = esc(r.title || r.bvid || '未识别');

  const live = liveDate(r);
  const meta = [
    r.streamer_name ? `<span class="tag persona" style="${personaStyle(r.streamer_name)}">${esc(r.streamer_name)}</span>` : '',
    live ? `<span class="mid">直播 ${esc(live.label)}</span>` : '',
    r.english ? `<span class="tag on">${esc(r.english)}</span>` : '',
    r.parts > 1 ? `<span class="tag">第 ${r.part} / ${r.parts} P</span>` : '',
    r.duration ? `<span class="mid">时长 ${render.fmtDuration(r.duration)}</span>` : '',
    `<span class="mid">生成于 ${esc(localTime(r.updated_at))}</span>`,
    r.name_fixes ? `<span class="mid">已修正人名</span>` : '',
  ].filter(Boolean).join(' ');

  const segCount = timeline && timeline.segments.length;
  const transcriptBody = timeline
    ? segCount
      ? render.renderTimeline(timeline)
      : `<pre>${esc(timeline.text || '（无转录内容）')}</pre>`
    : '<p class="hint">这条任务没有保存转录文本。</p>';

  const body = `
${heroHtml(r.title || '录播报告', '../assets/')}
<header>
  <h1>🎤 ${title}</h1>
  <p class="sub">录播报告 · 静态导出</p>
  <nav class="nav">
    <a class="primary" href="../index.html">← 报告库</a>
    <a href="${esc(r.url)}" target="_blank">原视频</a>
    <a href="../markdown/${file}.md" download>下载 Markdown</a>
  </nav>
  <p class="meta">${meta}</p>
</header>
<main>
  <section class="card">
    <h2>报告全文</h2>
    <div class="report">${render.renderMarkdown(r.report, r.url)}</div>
  </section>
  <section class="card">
    <details>
      <summary>带时间戳的转录（${segCount ? segCount + ' 条' : '全文'} · 点击时间跳转原视频）</summary>
      <div class="timeline full">${transcriptBody}</div>
    </details>
  </section>
  <p class="hint">静态导出，无服务端：时间戳链接直接指向 B站，PC 用 <code>?t=</code>，手机端 app 用 <code>start_progress=</code>。</p>
</main>
`;
  return pageShell(title + ' · 录播报告', body, '../assets/');
}

function indexPage(reports, render) {
  const esc = render.esc;
  const totalSeconds = reports.reduce((s, r) => s + (r.duration || 0), 0);

  // default: newest stream first, using the date written in the title
  // ("2026-10-11直播录像"). Reports whose title has no date are ordered by when
  // they were generated, so they never get placed in the wrong month.
  const withDate = reports.map((r) => ({ r, live: liveDate(r) }));
  const sorted = withDate.sort((a, b) =>
    (b.live ? b.live.stamp : 0) - (a.live ? a.live.stamp : 0) ||
    (b.live ? b.live.ts : 0) - (a.live ? a.live.ts : 0) ||
    sortTime(b.r) - sortTime(a.r) ||
    (b.r.id || 0) - (a.r.id || 0)
  );

  const cards = sorted.map(({ r, live }) => {
    const file = slug(r);
    const title = esc(r.title || r.bvid || '未识别');
    // the searchable index stays small: the report text lives on its own page
    const search = [r.title, r.bvid, r.streamer_name, r.english].filter(Boolean).join(' ').toLowerCase();
    const meta = [
      r.streamer_name ? `<span class="tag persona" style="${personaStyle(r.streamer_name)}">${esc(r.streamer_name)}</span>` : '',
      live ? `<span class="mid">直播 ${esc(live.label)}</span>` : '',
      r.parts > 1 ? `<span class="tag">P${r.part}/${r.parts}</span>` : '',
      r.duration ? `<span class="mid">时长 ${render.fmtDuration(r.duration)}</span>` : '',
      `<span class="mid">生成于 ${esc(localTime(r.updated_at))}</span>`,
    ].join(' ');
    return `
    <article class="report-card" data-search="${esc(search)}" data-id="${r.id || 0}" data-ts="${sortTime(r)}" data-live="${live ? live.stamp : 0}" data-livets="${live ? live.ts : 0}">
      <div class="report-head">
        <a class="report-title" href="reports/${file}.html">${title}</a>
        <span class="report-meta"><span class="tag">${esc(r.bvid || '')}</span>${meta}</span>
        <div class="report-actions">
          <a class="ghost" href="reports/${file}.html">报告 + 转录</a>
          <a class="ghost" href="markdown/${file}.md" download>Markdown</a>
          <a class="ghost" href="${esc(r.url)}" target="_blank">原视频</a>
        </div>
      </div>
    </article>`;
  }).join('\n');

  const body = `
${heroHtml('VTuber 录播报告库', 'assets/')}
<header>
  <h1>🎤 VTuber 录播报告库</h1>
  <p class="sub">静态导出 · ${reports.length} 份报告 · 总时长 ${render.fmtDuration(totalSeconds)} · 生成于 ${esc(new Date().toLocaleString())}</p>
</header>
<main>
  <section class="card">
    <div class="row">
      <input id="q" type="text" placeholder="搜索标题 / 主播 / BV号…" />
      <select id="sort">
        <option value="live" selected>按直播日期：最新 → 最早</option>
        <option value="liveold">按直播日期：最早 → 最新</option>
        <option value="new">按生成时间：最新 → 最早</option>
        <option value="old">按生成时间：最早 → 最新</option>
      </select>
      <span id="count" class="hint">显示 ${reports.length} 份</span>
    </div>
  </section>
  <div class="reports">${cards}</div>
  <p class="hint">排序默认按标题里识别出的直播日期；标题里没有日期的报告按生成时间排在后面。</p>
</main>
<script src="assets/site.js"></script>
`;
  return pageShell('录播报告库 · 静态导出', body, 'assets/');
}

const SITE_JS = `(function () {
  // front-page filter + sort: hide cards that do not contain the query, then
  // re-order the whole list by stream date or by generation time
  const input = document.getElementById('q');
  const sortSel = document.getElementById('sort');
  const count = document.getElementById('count');
  const list = document.querySelector('.reports');
  if (!input || !list) return;
  const cards = Array.from(list.querySelectorAll('.report-card'));
  function apply() {
    const q = input.value.trim().toLowerCase();
    let shown = 0;
    for (const c of cards) {
      const hit = !q || (c.dataset.search || '').includes(q);
      c.hidden = !hit;
      if (hit) shown += 1;
    }
    if (count) count.textContent = '显示 ' + shown + ' / ' + cards.length + ' 份';
  }
  function sortCards() {
    const mode = sortSel ? sortSel.value : 'live';
    // dir = -1 sorts high values first (newest), +1 sorts low values first (oldest)
    const dir = mode === 'new' || mode === 'live' ? -1 : 1;
    const field = mode === 'new' || mode === 'old' ? 'ts' : 'livets';
    const byDate = field === 'livets';
    cards.sort((a, b) => {
      // a report whose title has no stream date has no known position: keep it at
      // the end of the list whatever the direction is
      if (byDate) {
        const unknownA = !Number(a.dataset.livets);
        const unknownB = !Number(b.dataset.livets);
        if (unknownA !== unknownB) return unknownA ? 1 : -1;
      }
      const d = dir * ((Number(a.dataset[field]) || 0) - (Number(b.dataset[field]) || 0));
      if (d) return d;
      // same date -> generation time, then id
      return dir * ((Number(a.dataset.ts) || 0) - (Number(b.dataset.ts) || 0)) ||
        (Number(b.dataset.id) || 0) - (Number(a.dataset.id) || 0);
    });
    for (const c of cards) list.appendChild(c);
  }
  input.addEventListener('input', apply);
  if (sortSel) sortSel.addEventListener('change', sortCards);
  apply();
})();
`;

const SITE_CSS = `
/* exported report library: full transcript pages need no scrolling cap */
.timeline.full { max-height: none; }
.report-card[hidden] { display: none; }
main .report p { margin: 8px 0; }
/* the banner, the title, the buttons and the tags all share the content column
 * (main is max-width 960px), so widening the window centers them instead of
 * leaving them pinned to the left edge */
header { max-width: 960px; margin: 0 auto; padding: 18px 24px 6px; text-align: center; }
header .meta { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; color: var(--muted); font-size: 12px; margin: 10px 0 0; }
/* title banner from the project root: centered at the very top of every page */
.hero { display: flex; justify-content: center; max-width: 960px; margin: 0 auto; padding: 18px 24px 0; }
.hero img { display: block; max-width: min(760px, 100%); height: auto; border-radius: 12px; box-shadow: var(--shadow); }
/* the links above the page become real buttons: bigger tap target, clear border */
.nav { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin: 12px 0 0; }
.nav a {
  display: inline-flex; align-items: center; gap: 6px;
  min-height: 36px; padding: 9px 16px;
  border: 1px solid var(--border-strong); border-radius: 10px;
  background: var(--card); color: var(--accent-deep);
  font-size: 13px; font-weight: 600; text-decoration: none;
  box-shadow: var(--shadow);
}
.nav a:hover { background: var(--accent-tint); border-color: var(--accent); }
.nav a.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.nav a.primary:hover { background: var(--accent-deep); color: #fff; }
/* one colour per persona: the hue is derived from the name in staticsite.js and
   written inline on the tag, so a new streamer is coloured without editing CSS */
.tag.persona { font-weight: 600; }
`;

let previewServer = null;

// optional local preview so the exported folder can be opened before uploading it
function ensurePreview() {
  if (previewServer) return { port: config.SITE_PORT, started: true };
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${config.SITE_PORT}`);
      let p = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = path.join(config.SITE_DIR, p);
      if (!file.startsWith(config.SITE_DIR) || !fs.existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(file));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(String(e.message || e));
    }
  });
  server.on('error', (e) => {
    console.error('[site] preview server failed on port', config.SITE_PORT, e.message);
    previewServer = null;
  });
  server.listen(config.SITE_PORT, () => {
    console.log(`[site] static preview on http://localhost:${config.SITE_PORT}`);
  });
  previewServer = server;
  return { port: config.SITE_PORT, started: true };
}

function build() {
  const dir = config.SITE_DIR;
  const render = renderer();
  const reports = db.listReports({ limit: 1000 });

  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'markdown'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });

  const files = [];
  const write = (rel, content) => {
    fs.writeFileSync(path.join(dir, rel), content, 'utf8');
    files.push(rel);
  };

  if (copyTitleImage(dir)) files.push('assets/' + titleImage);

  for (const r of reports) {
    const file = slug(r);
    write(`reports/${file}.html`, reportPage(r, render));
    write(
      `markdown/${file}.md`,
      `# ${r.title || r.bvid}\n\n来源: ${r.url}\n主播: ${r.streamer_name || ''}\n生成时间: ${localTime(r.updated_at)}\n\n${r.report}\n`
    );
  }
  // pages of reports that are no longer in the database (deleted or cancelled jobs)
  // would stay reachable by direct URL, so they are removed on every build
  const keep = new Set(reports.map((r) => slug(r)));
  const removed = [];
  for (const sub of ['reports', 'markdown']) {
    const ext = sub === 'reports' ? '.html' : '.md';
    for (const name of fs.readdirSync(path.join(dir, sub))) {
      if (!name.endsWith(ext) || keep.has(name.slice(0, -ext.length))) continue;
      fs.unlinkSync(path.join(dir, sub, name));
      removed.push(`${sub}/${name}`);
    }
  }

  write('index.html', indexPage(reports, render));
  write(
    'assets/style.css',
    fs.readFileSync(path.join(config.ROOT, 'public', 'style.css'), 'utf8') + SITE_CSS
  );
  write('assets/site.js', SITE_JS);
  write(
    'README.md',
    `# 录播报告库（静态导出）\n\n` +
    `生成时间: ${new Date().toLocaleString()}\n报告数: ${reports.length}\n\n` +
    `整个目录可以直接上传到任何静态托管（GitHub Pages / Cloudflare Pages / nginx / 对象存储），\n` +
    `不需要后端：\n\n` +
    `- \`index.html\` 报告库首页（默认按标题里识别出的直播日期排序，带搜索和排序菜单)\n` +
    `- \`reports/BVxxxx.html\` 每份报告的页面：报告全文 + 带时间戳的转录\n` +
    `- \`markdown/BVxxxx.md\` 原始 Markdown\n` +
    `- \`assets/\` 样式、搜索脚本与标题图\n\n` +
    `时间戳链接指向 B站，PC 端用 \`?t=<秒>\`，手机端 app 用 \`start_progress=<毫秒>\`。\n\n` +
    `本地预览：在 liklo 后台点「生成静态报告库」，页面会同时在本机 ${config.SITE_PORT} 端口提供预览。\n`
  );

  const preview = ensurePreview();
  if (removed.length) console.log(`[site] removed ${removed.length} orphan pages of deleted reports`);
  return {
    dir,
    reports: reports.length,
    files: files.length,
    removed: removed.length,
    preview: `http://localhost:${preview.port}`,
    generatedAt: new Date().toISOString(),
  };
}

// auto rebuild: whenever a report is finished the exported site is regenerated.
// Several reports finishing at once collapse into one build (debounce), and the
// build itself is cheap (a few seconds of file writing).
const AUTO_DELAY_MS = Number(process.env.LIKLO_SITE_AUTO_DELAY || '5000');
let pendingBuild = null;

function scheduleBuild(reason = 'new report') {
  if (process.env.LIKLO_SITE_AUTO === '0') return;
  if (pendingBuild) return;
  pendingBuild = setTimeout(() => {
    pendingBuild = null;
    try {
      const r = build();
      console.log(`[site] auto rebuild after ${reason}: ${r.reports} reports, ${r.files} files -> ${r.dir}`);
    } catch (e) {
      console.error('[site] auto rebuild failed:', e.message || e);
    }
  }, AUTO_DELAY_MS);
}

function status() {
  const dir = config.SITE_DIR;
  if (!fs.existsSync(dir)) return { exists: false, dir };
  const index = path.join(dir, 'index.html');
  return {
    exists: fs.existsSync(index),
    dir,
    reports: fs.existsSync(path.join(dir, 'reports')) ? fs.readdirSync(path.join(dir, 'reports')).filter((f) => f.endsWith('.html')).length : 0,
    generatedAt: fs.existsSync(index) ? new Date(fs.statSync(index).mtime).toISOString() : null,
    preview: `http://localhost:${config.SITE_PORT}`,
  };
}

module.exports = { build, status, ensurePreview, scheduleBuild, liveDate, personaStyle };
