'use strict';

// report library page: lists every completed report (status = done) with filters
const state = { reports: [], rendered: new Map() };

function localTime(utc) {
  if (!utc) return '';
  const d = new Date(String(utc).replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? String(utc) : d.toLocaleString();
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
    `<span class="mid">报告 ${String(r.report || '').length} 字符</span>`,
  ].join(' ');

  return `
    <article class="report-card" data-id="${r.id}">
      <div class="report-head">
        <a class="report-title" href="${esc(r.url)}" target="_blank">${title}</a>
        <span class="report-meta">${meta}</span>
        <div class="report-actions">
          <button class="ghost" data-toggle="${r.id}">展开报告</button>
          <a class="ghost" href="/api/reports/${r.id}/markdown" download="report-${esc(r.bvid || r.id)}.md">下载 Markdown</a>
          <button class="ghost" data-copy="${r.id}">复制报告</button>
          ${r.has_transcript ? `<button class="ghost" data-transcript="${r.id}">带时间戳的转录</button>` : ''}
          <button class="ghost" data-fixnames="${r.id}">姓名修正</button>
          ${r.has_transcript ? `<button class="ghost" data-regen="${r.id}">重新生成报告</button>` : ''}
        </div>
      </div>
      ${fixesHtml(parseFixes(r.name_fixes))}
      <div class="report-body" data-body="${r.id}" hidden></div>
      ${r.has_transcript ? `<div class="transcript-panel" data-transcript-body="${r.id}" hidden></div>` : ''}
    </article>
  `;
}

function render() {
  const list = filtered();
  const el = $('reports');
  const total = state.reports.length;
  const totalSeconds = state.reports.reduce((s, r) => s + (r.duration || 0), 0);
  $('count').textContent = `共 ${total} 条报告（总时长 ${fmtDuration(totalSeconds)}），当前显示 ${list.length} 条`;

  if (!list.length) {
    el.innerHTML = '<p class="hint">没有匹配的报告。任务完成后报告会自动出现在这里。</p>';
    return;
  }
  el.innerHTML = list.map(cardHtml).join('');
}

async function load() {
  try {
    state.reports = await api('/api/reports');
    state.rendered.clear();
    const names = [...new Set(state.reports.map((r) => r.english || r.streamer_name).filter(Boolean))];
    $('streamer').innerHTML =
      '<option value="">全部主播</option>' + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    render();
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

// timestamped transcript is fetched lazily, inline on this page (no jump to the task list)
const timelineCache = new Map();

function filterSegments(t, q) {
  const segs = (t.segments || []).filter((s) => s.start != null && s.text);
  if (!q) return segs;
  return segs.filter(
    (s) => String(s.text).toLowerCase().includes(q) || String(s.speaker || '').toLowerCase().includes(q)
  );
}

function transcriptHtml(t, id) {
  return `
    <div class="tl-tools">
      <input class="tl-filter" type="search" placeholder="过滤转录内容 / 说话人…" />
      <span class="mid">${(t.segments || []).length} 条 · 总时长 ${fmtDuration(t.duration || 0)}</span>
      <a class="ghost" href="/api/jobs/${id}/transcript" download="transcript-${esc(t.bvid || id)}.json">下载 JSON</a>
    </div>
    <div class="timeline" data-timeline="${id}"></div>`;
}

function bindTranscriptFilter(panel, id) {
  const input = panel.querySelector('.tl-filter');
  const tl = panel.querySelector('[data-timeline]');
  if (!input || !tl) return;
  input.addEventListener('input', () => {
    const t = timelineCache.get(id);
    if (!t) return;
    const q = input.value.trim().toLowerCase();
    tl.innerHTML = renderTimeline({ segments: filterSegments(t, q), url: t.url, text: t.text });
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
    const t = await api(`/api/jobs/${id}/timeline`);
    timelineCache.set(id, t);
    panel.innerHTML = transcriptHtml(t, id);
    panel.querySelector('[data-timeline]').innerHTML = renderTimeline(t);
    bindTranscriptFilter(panel, id);
    toast(`已加载 ${String(t.bvid || id)} 的带时间戳转录`);
  } catch (e) {
    panel.innerHTML = `<p class="hint">转录加载失败: ${esc(e.message)}</p>`;
  }
}

$('reports').addEventListener('click', async (ev) => {
  const node = ev.target.closest('[data-toggle],[data-copy],[data-transcript],[data-fixnames],[data-regen]');
  if (!node) return;

  if (node.dataset.toggle) {
    showReport(Number(node.dataset.toggle), node);
    return;
  }

  if (node.dataset.transcript) {
    showTranscript(Number(node.dataset.transcript), node);
    return;
  }

  if (node.dataset.fixnames) {
    const id = Number(node.dataset.fixnames);
    node.disabled = true;
    node.textContent = '修正中…';
    toast('正在用最新姓名表 + LLM 重新校验人名…');
    try {
      const r = await api(`/api/reports/${id}/fix-names`, { method: 'POST' });
      const applied = r.applied || [];
      const reverted = r.reverted || [];
      if (applied.length) {
        toast(
          `已按最新姓名表修正 ${applied.length} 组人名（共 ${applied.reduce((s, f) => s + (f.count || 0), 0)} 处）：` +
            applied.map((f) => `${f.wrong}→${f.correct} ×${f.count}`).join('，')
        );
      } else if (reverted.length) {
        toast(
          `姓名表已更新，撤销 ${reverted.length} 组不再支持的修正：` +
            reverted.map((f) => `${f.correct}→${f.wrong}`).join('，')
        );
      } else {
        toast(r.reason || '最新姓名表下没有需要修正的人名');
      }
      timelineCache.delete(id); // transcript text changed
      await load();
    } catch (e) {
      toast('姓名修正失败: ' + e.message);
    }
    node.disabled = false;
    node.textContent = '姓名修正';
    return;
  }

  if (node.dataset.regen) {
    const id = Number(node.dataset.regen);
    const wasOpen = !document.querySelector(`[data-body="${id}"]`)?.hidden;
    node.disabled = true;
    node.textContent = '生成中…';
    toast('正在用已有转录重新生成报告（不下载、不转录）…');
    try {
      const job = await api(`/api/jobs/${id}/report`, { method: 'POST' });
      const fixes = parseFixes(job.name_fixes) || [];
      const text = String(job.report || '');
      toast(
        `已重新生成报告（${text.length} 字符` +
          (fixes.length ? `，人名修正 ${fixes.length} 组` : '') +
          '）'
      );
      state.rendered.delete(id);
      timelineCache.delete(id); // transcript text may have changed
      await load();
      if (wasOpen) showReport(id, document.querySelector(`[data-toggle="${id}"]`));
    } catch (e) {
      toast('重新生成失败: ' + e.message);
      node.disabled = false;
      node.textContent = '重新生成报告';
    }
    return;
  }

  const id = Number(node.dataset.copy);
  const r = state.reports.find((x) => x.id === id);
  if (!r) return;
  const text = r.report || '';
  try {
    if (navigator.clipboard) await navigator.clipboard.writeText(text);
    else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(`已复制报告（${text.length} 字符）`);
  } catch (e) {
    toast('复制失败: ' + e.message);
  }
});

['q', 'streamer', 'sort'].forEach((id) => $(id).addEventListener('change', render));
$('q').addEventListener('input', render);
$('reload').addEventListener('click', load);

load();
