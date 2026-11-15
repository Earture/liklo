'use strict';

// read-only report library (public port). No job control, no editing: browsing,
// timestamps and Markdown download only.
const state = { reports: [], rendered: new Map() };
const timelineCache = new Map();

function localTime(utc) {
  if (!utc) return '';
  const d = new Date(String(utc).replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? String(utc) : d.toLocaleString();
}

// /r/BVxxxx or ?bvid=... / ?id=... opens one report directly, so a link can be shared
function targetKey() {
  const m = String(location.pathname).match(/^\/r\/(BV[^\/]+)$/i);
  if (m) return m[1];
  const q = new URLSearchParams(location.search);
  return (q.get('bvid') || q.get('id') || '').trim();
}

function filtered() {
  const q = $('q').value.trim().toLowerCase();
  const streamer = $('streamer').value;
  const sort = $('sort').value;

  let list = state.reports;
  if (streamer) list = list.filter((r) => r.streamer_name === streamer || r.english === streamer);
  if (q) {
    list = list.filter((r) =>
      String(r.title || '').toLowerCase().includes(q) ||
      String(r.streamer_name || '').toLowerCase().includes(q) ||
      String(r.bvid || '').toLowerCase().includes(q) ||
      String(r.english || '').toLowerCase().includes(q) ||
      String(r.report || '').toLowerCase().includes(q)
    );
  }
  const sorted = [...list];
  if (sort === 'old') sorted.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  else if (sort === 'duration') sorted.sort((a, b) => (b.duration || 0) - (a.duration || 0));
  else sorted.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return sorted;
}

function cardHtml(r) {
  const title = esc(r.title || r.bvid || '未识别');
  const meta = [
    r.english ? `<span class="tag on">${esc(r.english)}</span>` : '',
    personaTag(r.streamer_name),
    r.duration ? `<span class="mid">时长 ${fmtDuration(r.duration)}</span>` : '',
    `<span class="mid">生成于 ${esc(localTime(r.updated_at))}</span>`,
  ].join(' ');

  return `
    <article class="report-card" data-id="${r.id}">
      <div class="report-head">
        <a class="report-title" href="${esc(r.url)}" target="_blank">${title}</a>
        <span class="report-meta">${meta}</span>
        <div class="report-actions">
          <button class="ghost" data-toggle="${r.id}">展开报告</button>
          <a class="ghost" href="/api/reports/${r.id}/markdown" download="report-${esc(r.bvid || r.id)}.md">下载 Markdown</a>
          ${r.has_transcript ? `<button class="ghost" data-transcript="${r.id}">带时间戳的转录</button>` : ''}
          <span class="share"><a href="/r/${esc(r.bvid || r.id)}">分享链接</a></span>
        </div>
      </div>
      <div class="report-body" data-body="${r.id}" hidden></div>
      ${r.has_transcript ? `<div class="transcript-panel" data-transcript-body="${r.id}" hidden></div>` : ''}
    </article>`;
}

function render() {
  const list = filtered();
  const total = state.reports.length;
  const totalSeconds = state.reports.reduce((s, r) => s + (r.duration || 0), 0);
  $('count').textContent = `共 ${total} 条报告（总时长 ${fmtDuration(totalSeconds)}），当前显示 ${list.length} 条`;

  if (!list.length) {
    $('reports').innerHTML = '<p class="hint">没有匹配的报告。新报告生成后会自动出现在这里。</p>';
    return;
  }
  $('reports').innerHTML = list.map(cardHtml).join('');
}

async function load() {
  try {
    state.reports = await api('/api/reports');
    state.rendered.clear();
    const names = [...new Set(state.reports.map((r) => r.english || r.streamer_name).filter(Boolean))];
    $('streamer').innerHTML =
      '<option value="">全部主播</option>' + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    render();
    const key = targetKey();
    if (key) {
      const r = state.reports.find((x) => String(x.bvid).toLowerCase() === key.toLowerCase() || String(x.id) === key);
      if (r) {
        showReport(r.id);
        const card = document.querySelector(`[data-id="${r.id}"]`);
        if (card) {
          card.classList.add('open');
          card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      } else {
        toast(`没有找到 ${key} 的报告`);
      }
    }
  } catch (e) {
    toast('加载报告失败: ' + e.message);
    $('reports').innerHTML = `<p class="hint">加载失败: ${esc(e.message)}</p>`;
  }
}

function showReport(id, btn) {
  const body = document.querySelector(`[data-body="${id}"]`);
  if (!body) return;
  const open = body.hidden;
  body.hidden = !open;
  if (btn) btn.textContent = body.hidden ? '展开报告' : '收起报告';
  if (!open) return; // collapsing: keep the rendered html, just hide it
  if (body.innerHTML) return;
  const r = state.reports.find((x) => x.id === id);
  if (!r) return;
  if (state.rendered.has(id)) {
    body.innerHTML = state.rendered.get(id);
    return;
  }
  const html = renderMarkdown(r.report, r.url);
  state.rendered.set(id, html);
  body.innerHTML = html;
}

function filterSegments(t, q) {
  const segs = (t.segments || []).filter((s) => s.start != null && s.text);
  if (!q) return segs;
  return segs.filter(
    (s) => String(s.text).toLowerCase().includes(q) || String(s.speaker || '').toLowerCase().includes(q)
  );
}

function transcriptHtml(t, key) {
  return `
    <div class="tl-tools">
      <input class="tl-filter" type="search" placeholder="过滤转录内容 / 说话人…" />
      <span class="mid">${(t.segments || []).length} 条 · 总时长 ${fmtDuration(t.duration || 0)}</span>
    </div>
    <div class="timeline" data-timeline="${key}"></div>`;
}

function bindTranscriptFilter(panel, key) {
  const input = panel.querySelector('.tl-filter');
  const tl = panel.querySelector('[data-timeline]');
  if (!input || !tl) return;
  input.addEventListener('input', () => {
    const t = timelineCache.get(key);
    if (!t) return;
    tl.innerHTML = renderTimeline({ segments: filterSegments(t, input.value.trim().toLowerCase()), url: t.url, text: t.text });
  });
}

async function showTranscript(id, btn) {
  const panel = document.querySelector(`[data-transcript-body="${id}"]`);
  if (!panel) return;
  if (!panel.hidden) {
    panel.hidden = true;
    if (btn) btn.textContent = '带时间戳的转录';
    return;
  }
  panel.hidden = false;
  if (btn) btn.textContent = '隐藏转录';
  if (timelineCache.has(id)) {
    panel.innerHTML = transcriptHtml(timelineCache.get(id), id);
    panel.querySelector('[data-timeline]').innerHTML = renderTimeline(timelineCache.get(id));
    bindTranscriptFilter(panel, id);
    return;
  }
  panel.innerHTML = '<p class="hint">加载转录…</p>';
  try {
    const t = await api(`/api/reports/${id}/timeline`);
    timelineCache.set(id, t);
    panel.innerHTML = transcriptHtml(t, id);
    panel.querySelector('[data-timeline]').innerHTML = renderTimeline(t);
    bindTranscriptFilter(panel, id);
    toast(`已加载 ${String(t.bvid || id)} 的带时间戳转录`);
  } catch (e) {
    panel.innerHTML = `<p class="hint">转录加载失败: ${esc(e.message)}</p>`;
  }
}

$('reports').addEventListener('click', (ev) => {
  const node = ev.target.closest('[data-toggle],[data-transcript]');
  if (!node) return;
  if (node.dataset.toggle) showReport(Number(node.dataset.toggle), node);
  else if (node.dataset.transcript) showTranscript(Number(node.dataset.transcript), node);
});

['q', 'streamer', 'sort'].forEach((id) => $(id).addEventListener('change', render));
$('q').addEventListener('input', render);
$('reload').addEventListener('click', load);

load();
