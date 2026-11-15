'use strict';

// $, api, esc, toast, fmtDuration, fmtTime, renderMarkdown come from /common.js

const state = {
  streamers: [],
  jobs: [],
  selected: null,
  total: 0,
  counts: {},
  page: { limit: 20, offset: 0, status: '' },
  paged: true,
};

/**
 * Mark a button as busy while its request is in flight, so clicking 取消 / 重试 /
 * 重新转录 never looks like the page froze. Returns a function that restores it.
 */
function busy(btn, label) {
  if (!btn) return () => {};
  const original = btn.textContent;
  btn.textContent = label;
  btn.disabled = true;
  return () => {
    btn.textContent = original;
    btn.disabled = false;
  };
}

const STATUS = {
  pending: '排队中',
  running: '处理中',
  ready: '待启动',
  done: '完成',
  error: '失败',
  cancelled: '已取消',
};

function renderStreamers() {
  const el = $('streamers');
  if (!state.streamers.length) {
    el.innerHTML = '<p class="hint">还没有主播。上方粘贴 UP 主页链接即可添加。</p>';
    return;
  }
  el.innerHTML = state.streamers.map((s) => `
    <div class="streamer">
      <span class="name">${esc(s.name)}</span>
      <span class="mid">mid ${esc(s.mid)} · 文件名 ${esc(s.english)}${s.match ? ' · 仅标题含 ' + esc(s.match) : ' · 未设关键词，默认按名称过滤'}</span>
      <span class="tag ${s.monitor ? 'on' : 'off'}">${s.monitor ? '监控开启' : '监控关闭'}</span>
      <button class="secondary" data-monitor="${esc(s.mid)}">${s.monitor ? '关闭监控' : '开启监控'}</button>
      <button data-delete="${esc(s.mid)}">删除</button>
      <span class="mid">${s.last_check_at ? '上次检查 ' + esc(s.last_check_at) : '未检查'}</span>
    </div>
  `).join('');

  const sel = $('job-streamer');
  sel.innerHTML = state.streamers.map((s) => `<option value="${esc(s.mid)}">${esc(s.name)}</option>`).join('');
  if (!state.streamers.length) sel.innerHTML = '<option value="">（先添加主播）</option>';
}

function renderJobs() {
  const el = $('jobs');
  if (!state.jobs.length) {
    el.innerHTML = '<p class="hint">暂无任务。粘贴一条录播链接，或开启监控自动抓取。</p>';
    return;
  }
  el.innerHTML = state.jobs.map((j) => `
    <div class="job ${state.selected === j.id ? 'active' : ''}" data-job="${j.id}">
      <span class="title">
        <strong>${j.parts > 1 ? `<span class="tag">P${j.part}/${j.parts}</span> ` : ''}${esc(j.title || j.bvid || '未识别')}</strong>
        <span class="mid">${personaTag(j.streamer_name)} · ${j.duration ? fmtDuration(j.duration) : ''}${j.parts > 1 ? ' · 该视频共 ' + j.parts + 'P，每个P独立任务' : ''} · ${esc(j.created_at)}</span>
        ${j.duplicate ? '<span class="tag off">疑似与其他P是同一场直播</span>' : ''}
        ${j.error ? `<span class="status error">⚠ ${esc(j.error)}</span>` : ''}
      </span>
      <span class="status ${j.status}">${STATUS[j.status] || j.status}${j.stage && j.stage !== j.status && j.status !== 'done' ? ' · ' + esc(j.stage) : ''}</span>
      ${j.status === 'ready' ? `<button class="secondary" data-start="${j.id}" title="这个P没有自动转录（多P视频默认只自动跑第1P），点击开始">开始转录</button>` : ''}
      ${j.status === 'error' || j.status === 'cancelled' ? `<button class="secondary" data-retry="${j.id}">重试</button>` : ''}
      ${(j.has_transcript || j.transcript || j.transcript_path) ? `<button class="ghost" data-retranscribe="${j.id}" title="删除已有转录结果和 ASR 缓存，用「服务配置」里当前设置的 ASR 重新转录（音频与分段文件保留）">重新转录</button>` : ''}
      ${j.status === 'pending' || j.status === 'running' ? `<button class="ghost" data-cancel="${j.id}">取消</button>` : ''}
      <button class="danger" data-delete="${j.id}" title="从任务列表删除（中间分段文件会被清理，音频与转录默认保留以便复用）">删除</button>
    </div>
  `).join('');
}

function renderPager() {
  const el = $('jobs-pager');
  const pages = Math.max(1, Math.ceil(state.total / state.page.limit));
  const cur = Math.floor(state.page.offset / state.page.limit) + 1;
  $('jobs-count').textContent = state.total
    ? `共 ${state.total} 条任务${state.page.status ? '（' + (STATUS[state.page.status] || state.page.status) + '）' : ''} · 完成 ${state.counts.done || 0} · 排队/处理 ${state.counts.pending || 0}/${state.counts.running || 0} · 已取消 ${state.counts.cancelled || 0}`
    : '没有任务';
  if (!state.total) { el.innerHTML = ''; return; }
  if (!state.paged) {
    // an older server process still answers /api/jobs with a bare array: no total,
    // so paging is impossible until it is restarted
    el.innerHTML = '<span class="mid">当前服务不支持分页（旧进程），重启 liklo 服务后分页生效</span>';
    return;
  }
  const btn = (page, label, disabled) =>
    `<button class="ghost" data-page="${page}" ${disabled ? 'disabled' : ''}>${label}</button>`;
  const numbers = [];
  for (let p = 1; p <= pages; p++) {
    // keep the row short: only the pages near the current one, plus the ends
    if (pages <= 8 || p === 1 || p === pages || Math.abs(p - cur) <= 1) numbers.push(btn(p, p, p === cur));
  }
  el.innerHTML =
    btn(cur - 1, '← 上一页', cur <= 1) +
    numbers.join('') +
    btn(cur + 1, '下一页 →', cur >= pages) +
    `<span class="mid">第 ${cur} / ${pages} 页 · 每页 ${state.page.limit} 条</span>`;
}

function renderDetail(job) {
  const detail = $('detail');
  if (!job) { detail.hidden = true; return; }
  detail.hidden = false;
  $('detail-title').textContent = job.title || job.bvid;
  $('detail-meta').innerHTML = `
    <span class="status ${job.status}">${STATUS[job.status] || job.status}</span>
    ${job.stage ? ' · ' + esc(job.stage) : ''}
    ${job.duration ? ' · 时长 ' + fmtDuration(job.duration) : ''}
    ${job.source_url ? '' : ''}
    ${job.url ? `<a href="${esc(job.url)}" target="_blank">原视频</a>` : ''}
    ${job.audio_path ? ' · 音频 ' + esc(job.audio_path.split('\\').pop()) : ''}
    ${job.transcript || job.transcript_path ? `<button class="ghost" data-regen="${job.id}">重新生成报告（复用转录）</button>` : ''}
    ${job.transcript || job.transcript_path ? `<button class="ghost" data-retranscribe="${job.id}" title="删除已有转录结果和 ASR 缓存，用「服务配置」里当前设置的 ASR 重新转录（音频与分段文件保留）">重新转录</button>` : ''}
    ${job.parts > 1 ? `<span class="tag">第 ${job.part} / ${job.parts} P</span>` : ''}
    ${job.duplicate ? '<span class="tag off">疑似与其他P是同一场直播</span>' : ''}
    ${job.status === 'ready' ? `<button class="secondary" data-start="${job.id}" title="多P视频默认只自动转录第1P，其余P按需启动">开始转录</button>` : ''}
    ${job.parts > 1 ? `<span class="mid">其余P是独立任务，在上方任务列表里各自有「开始转录」按钮</span>` : ''}
    ${job.transcript ? `<a class="ghost" href="/api/jobs/${job.id}/transcript" download>下载带时间戳的转录 JSON</a>` : ''}
  `;
  $('detail-report').innerHTML = job.report ? renderMarkdown(job.report, job.url) : '<p class="hint">报告尚未生成。</p>';
  const tr = $('detail-transcript');
  if (job.transcript || job.transcript_path) {
    tr.hidden = false;
    tr.dataset.job = String(job.id);
    if (timelineCache.jobId !== job.id) $('detail-timeline').innerHTML = '';
    else $('detail-timeline').innerHTML = timelineCache.html;
  } else {
    tr.hidden = true;
  }
}

// the timestamped transcript is fetched lazily, only when the panel is opened
const timelineCache = { jobId: null, html: '' };
$('detail-transcript').addEventListener('toggle', async (ev) => {
  const el = ev.target;
  if (!el.open) return;
  const jobId = Number(el.dataset.job);
  if (!jobId) return;
  if (timelineCache.jobId === jobId) {
    $('detail-timeline').innerHTML = timelineCache.html;
    return;
  }
  $('detail-timeline').innerHTML = '<p class="hint">加载转录…</p>';
  try {
    const t = await api(`/api/jobs/${jobId}/timeline`);
    timelineCache.jobId = jobId;
    timelineCache.html = renderTimeline(t);
    $('detail-timeline').innerHTML = timelineCache.html;
  } catch (e) {
    toast('转录加载失败: ' + e.message);
  }
});

async function refresh() {
  try {
    const qs = new URLSearchParams({ limit: String(state.page.limit), offset: String(state.page.offset) });
    if (state.page.status) qs.set('status', state.page.status);
    const [streamers, res] = await Promise.all([api('/api/streamers'), api('/api/jobs?' + qs.toString())]);
    state.streamers = streamers;
    // a server started before this change still returns a bare array; accept both
    state.jobs = Array.isArray(res) ? res : res.jobs || [];
    state.total = Array.isArray(res) ? res.length : res.total || 0;
    state.counts = (res && res.counts) || {};
    state.paged = !Array.isArray(res);
    renderStreamers();
    renderJobs();
    renderPager();
    if (state.selected) {
      // the selected job may be on another page, so read it directly
      try {
        renderDetail(await api(`/api/jobs/${state.selected}`));
      } catch {
        renderDetail(null);
      }
    }
  } catch (e) {
    toast('加载失败: ' + e.message);
  }
}

$('jobs-pager').addEventListener('click', async (ev) => {
  const page = Number(ev.target.dataset.page);
  if (!page) return;
  state.page.offset = Math.max(0, (page - 1) * state.page.limit);
  await refresh();
});

$('job-status').addEventListener('change', async (ev) => {
  state.page.status = ev.target.value;
  state.page.offset = 0;
  await refresh();
});

$('job-page-size').addEventListener('change', async (ev) => {
  state.page.limit = Math.max(1, Number(ev.target.value) || 20);
  state.page.offset = 0;
  await refresh();
});

$('streamer-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    const s = await api('/api/streamers', {
      method: 'POST',
      body: JSON.stringify({
        url: $('s-mid').value,
        name: $('s-name').value || undefined,
        english: $('s-english').value || undefined,
        keywords: $('s-keywords').value || undefined,
        match: $('s-match').value || undefined,
        monitor: $('s-monitor').checked,
      }),
    });
    toast(`已添加 ${s.name} (mid ${s.mid})`);
    $('streamer-form').reset();
    await refresh();
  } catch (e) {
    toast('添加失败: ' + e.message);
  }
});

$('streamers').addEventListener('click', async (ev) => {
  const node = ev.target.closest('[data-monitor],[data-delete]');
  const mid = node && (node.dataset.monitor || node.dataset.delete);
  if (!mid) return;
  try {
    if (node.dataset.delete) {
      await api(`/api/streamers/${mid}`, { method: 'DELETE' });
      toast('已删除主播');
    } else {
      const s = state.streamers.find((x) => x.mid === mid);
      await api(`/api/streamers/${mid}/monitor`, { method: 'POST', body: JSON.stringify({ on: !s.monitor }) });
      toast('监控状态已更新');
    }
    await refresh();
  } catch (e) {
    toast('操作失败: ' + e.message);
  }
});

$('job-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const url = $('job-url').value.trim();
  if (!url) return;
  try {
    const job = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({
        url,
        streamerId: $('job-streamer').value || undefined,
        allParts: $('job-all-parts').checked,
      }),
    });
    state.selected = job.id;
    $('job-url').value = '';
    toast(`任务已入队: ${job.bvid}`);
    await refresh();
    renderDetail(job);
  } catch (e) {
    toast('提交失败: ' + e.message);
  }
});

$('jobs').addEventListener('click', async (ev) => {
  // the row is a div with nested spans/buttons: resolve the element that actually
  // carries the action so clicking anywhere in the row works
  const node = ev.target.closest('[data-delete],[data-cancel],[data-retry],[data-retranscribe],[data-start],[data-job]');
  if (!node) return;
  const startId = Number(node.dataset.start);
  if (startId) {
    const done = busy(node, '入队中…');
    try {
      const job = await api(`/api/jobs/${startId}/start`, { method: 'POST' });
      toast(`任务 ${startId}（${job.title || job.bvid}）已入队`);
      state.selected = startId;
      await refresh();
    } catch (e) {
      toast('启动失败: ' + e.message);
      done();
    }
    return;
  }
  const retranscribeId = Number(node.dataset.retranscribe);
  if (retranscribeId) {
    const done = busy(node, '重新转录中…');
    try {
      await api(`/api/jobs/${retranscribeId}/transcribe`, { method: 'POST' });
      toast(`任务 ${retranscribeId} 的旧转录已删除，重新转录已排队（音频与分段保留）`);
      await refresh();
    } catch (e) {
      toast('重新转录失败: ' + e.message);
      done();
    }
    return;
  }
  const deleteId = Number(node.dataset.delete);
  if (deleteId) {
    const job = state.jobs.find((j) => j.id === deleteId);
    const hasFiles = job && (job.audio_path || job.transcript || job.transcript_path);
    // OK = delete the job and all its files, Cancel = keep the cached audio/transcript
    const purge = hasFiles && confirm(
      `删除任务 ${deleteId}（${job.title || job.bvid}）。\n` +
      '确定 = 同时删除音频、转录和 ASR 缓存文件\n' +
      '取消 = 只从列表删除，保留缓存（以后同一条视频可以复用）'
    );
    const done = busy(node, '删除中…');
    try {
      const r = await api(`/api/jobs/${deleteId}${purge ? '?purge=1' : ''}`, { method: 'DELETE' });
      toast(`任务 ${deleteId} 已删除${r.removed ? '（清理 ' + r.removed + ' 个文件）' : ''}`);
      if (state.selected === deleteId) {
        state.selected = null;
        renderDetail(null);
      }
      await refresh();
    } catch (e) {
      toast('删除失败: ' + e.message);
      done();
    }
    return;
  }
  const cancelId = Number(node.dataset.cancel);
  if (cancelId) {
    const done = busy(node, '取消中…');
    try {
      await api(`/api/jobs/${cancelId}/cancel`, { method: 'POST' });
      toast(`任务 ${cancelId} 已取消`);
      await refresh();
    } catch (e) {
      toast('取消失败: ' + e.message);
      done();
    }
    return;
  }
  const retryId = Number(node.dataset.retry);
  if (retryId) {
    const done = busy(node, '重试入队中…');
    try {
      const job = await api(`/api/jobs/${retryId}`, { method: 'POST' });
      toast(`任务 ${retryId}（${job.title || job.bvid}）已重新入队`);
      state.selected = retryId;
      await refresh();
    } catch (e) {
      toast('重试失败: ' + e.message);
      done();
    }
    return;
  }
  const id = Number(node.dataset.job);
  if (!id) return;
  state.selected = id;
  try {
    renderDetail(await api(`/api/jobs/${id}`));
  } catch (e) {
    toast('加载失败: ' + e.message);
  }
});

$('detail').addEventListener('click', async (ev) => {
  const startBtn = ev.target.closest('[data-start]');
  if (startBtn) {
    const id = Number(startBtn.dataset.start);
    const done = busy(startBtn, '入队中…');
    try {
      const job = await api(`/api/jobs/${id}/start`, { method: 'POST' });
      renderDetail(job);
      renderJobs();
      toast(`任务 ${id}（${job.title || job.bvid}）已入队`);
    } catch (e) {
      toast('启动失败: ' + e.message);
      done();
    }
    return;
  }
  const retranscribeBtn = ev.target.closest('[data-retranscribe]');
  if (retranscribeBtn) {
    const id = Number(retranscribeBtn.dataset.retranscribe);
    const done = busy(retranscribeBtn, '重新转录中…');
    try {
      const job = await api(`/api/jobs/${id}/transcribe`, { method: 'POST' });
      renderDetail(job);
      renderJobs();
      toast(`任务 ${id} 的旧转录已删除，重新转录已排队（音频与分段保留）`);
    } catch (e) {
      toast('重新转录失败: ' + e.message);
      done();
    }
    return;
  }
  const regenBtn = ev.target.closest('[data-regen]');
  if (!regenBtn) return;
  const id = Number(regenBtn.dataset.regen);
  const done = busy(regenBtn, '生成报告中…（本地 LLM，可能要几分钟）');
  toast('正在重新生成报告（复用已转录结果）…');
  try {
    const job = await api(`/api/jobs/${id}/report`, { method: 'POST' });
    renderDetail(job);
    toast('报告已更新');
  } catch (e) {
    toast('生成失败: ' + e.message);
    done();
  }
});

const CFG_FIELDS = {
  ASR_BASE: 'cfg-asr-base',
  ASR_MODEL: 'cfg-asr-model',
  ASR_API_KEY: 'cfg-asr-key',
  LLM_BASE: 'cfg-llm-base',
  LLM_MODEL: 'cfg-llm-model',
  LLM_API_KEY: 'cfg-llm-key',
};

async function loadSettings() {
  const el = $('cfg-result');
  try {
    const s = await api('/api/settings');
    for (const [key, id] of Object.entries(CFG_FIELDS)) {
      const input = $(id);
      if (input && !input.value) input.value = s[key] || '';
    }
    el.textContent = `当前：ASR ${s.ASR_BASE} · LLM ${s.LLM_BASE}`;
  } catch (e) {
    el.textContent = e.message === 'not found'
      ? '当前服务还没有 /api/settings（重启服务后可用）'
      : '读取配置失败: ' + e.message;
  }
}

$('cfg-save').addEventListener('click', async () => {
  const el = $('cfg-result');
  const updates = {};
  for (const [key, id] of Object.entries(CFG_FIELDS)) {
    const v = $(id).value.trim();
    if (v) updates[key] = v;
  }
  for (const key of ['ASR_BASE', 'LLM_BASE']) {
    if (updates[key] && !/^https?:\/\//.test(updates[key])) {
      toast(`${key} 需要以 http:// 或 https:// 开头`);
      return;
    }
  }
  if (!Object.keys(updates).length) {
    toast('没有要保存的改动');
    return;
  }
  el.textContent = '保存中…';
  try {
    const s = await api('/api/settings', { method: 'POST', body: JSON.stringify(updates) });
    el.textContent = `已保存：ASR ${s.ASR_BASE} · LLM ${s.LLM_BASE}`;
    toast('服务配置已保存（写入 data/settings.json）');
  } catch (e) {
    el.textContent = '保存失败: ' + e.message;
  }
});

$('cfg-reset').addEventListener('click', async () => {
  const el = $('cfg-result');
  el.textContent = '恢复默认中…';
  try {
    const s = await api('/api/settings', { method: 'POST', body: JSON.stringify({ reset: true }) });
    for (const [key, id] of Object.entries(CFG_FIELDS)) $(id).value = s[key] || '';
    el.textContent = `已恢复默认：ASR ${s.ASR_BASE} · LLM ${s.LLM_BASE}`;
    toast('已删除 data/settings.json，恢复内置默认配置');
  } catch (e) {
    el.textContent = '恢复失败: ' + e.message;
  }
});

loadSettings();

// ---------- B站 cookies ----------
async function loadCookies() {
  const el = $('cookie-result');
  const detail = $('cookie-detail');
  try {
    const c = await api('/api/cookies');
    if (!c.exists) {
      el.textContent = '没有 cookie 文件：请求以匿名身份发送，合集/上传列表/搜索常被风控（412、-352）拦掉';
    } else {
      el.textContent =
        `${c.count} 条 cookie · ${c.imported ? '导入的' : '默认文件'} ${c.file}` +
        (c.hasBuvid ? ' · 有 buvid3' : ' · 无 buvid3') +
        (c.hasLoginCookie ? ' · 有登录 cookie (bili_jct)' : '') +
        (c.expired.length ? ` · 跳过 ${c.expired.length} 条过期（${c.expired.join(', ')}）` : '');
      if (c.rejected) {
        el.textContent += ' · B站 不认这份 cookie（未登录），已自动退回匿名请求：导出一份新的 cookies.txt 再导入';
      }
    }
    detail.textContent = c.names.length ? '包含: ' + c.names.join(', ') : '';
  } catch (e) {
    el.textContent = '读取 cookie 状态失败: ' + e.message;
  }
}

$('cookie-import').addEventListener('click', async () => {
  const el = $('cookie-result');
  const file = $('cookie-file').files[0];
  const text = file ? await file.text() : $('cookie-paste').value.trim();
  if (!text) {
    toast('选择 cookies.txt，或粘贴一段 Cookie 头');
    return;
  }
  el.textContent = '导入中…';
  try {
    const c = await api('/api/cookies', { method: 'POST', body: JSON.stringify({ text }) });
    toast(`已导入 ${c.count} 条 cookie → ${c.file}`);
    loadCookies();
  } catch (e) {
    el.textContent = '导入失败: ' + e.message;
  }
});

$('cookie-clear').addEventListener('click', async () => {
  const el = $('cookie-result');
  try {
    await api('/api/cookies', { method: 'DELETE' });
    toast('已清除导入的 cookies，回到默认 cookie 文件');
    loadCookies();
  } catch (e) {
    el.textContent = '清除失败: ' + e.message;
  }
});

$('cookie-verify').addEventListener('click', async () => {
  const el = $('cookie-result');
  const detail = $('cookie-detail');
  el.textContent = '验证中…（调用 B站 接口，约 10 秒）';
  try {
    const r = await api('/api/cookies/verify', { method: 'POST', body: JSON.stringify({}) });
    const ok = r.checks.filter((c) => c.ok).length;
    el.textContent = `验证完成：${ok}/${r.checks.length} 个接口可用（mid ${r.mid}）`;
    detail.innerHTML = r.checks
      .map((c) => `${c.ok ? '✓' : '✗'} ${esc(c.label)}: ${c.ok ? esc(JSON.stringify(c.detail)) : esc(c.error)}`)
      .join('<br>');
    toast(ok === r.checks.length ? '所有接口都可用' : '部分接口仍被风控：合集列表和搜索够用，上传列表常被 -352 拦');
  } catch (e) {
    el.textContent = '验证失败: ' + e.message;
  }
});

loadCookies();

$('svc-check').addEventListener('click', async () => {
  const el = $('svc-result');
  el.textContent = '检测中…（ASR 最多等待 60 秒）';
  try {
    const s = await api('/api/services-status');
    const asr = s.asr.ok
      ? `ASR 正常：${s.asr.elapsed}s 返回 ${s.asr.chars} 字符`
      : s.asr.busy
        ? 'ASR 正在转写其它片段（队列忙），这不是故障'
        : `ASR 不可用：${s.asr.error || 'HTTP ' + s.asr.status}（等待 ${s.asr.elapsed}s）`;
    const llm = s.llm.ok ? `LLM 正常（${s.llm.model}）` : `LLM 不可用：${s.llm.error || 'HTTP ' + s.llm.status}`;
    el.textContent = `${asr} · ${llm}`;
    el.title = `检测地址：ASR ${s.asr.base} · LLM ${s.llm.base}`;
    toast(el.textContent);
  } catch (e) {
    el.textContent = '检测失败: ' + e.message;
  }
});

$('monitor-run').addEventListener('click', async () => {
  const el = $('monitor-result');
  const diag = $('monitor-diag');
  el.textContent = '检查中…';
  try {
    // the pass runs in the background; poll for progress instead of blocking
    let s = await api('/api/monitor/run', {
      method: 'POST',
      body: JSON.stringify({ rediscover: $('monitor-rediscover').checked }),
    });
    for (let i = 0; i < 90 && s.running; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      s = await api('/api/monitor/status');
      if (s.progress) el.textContent = s.progress;
    }
    if (s.created) {
      el.textContent = `发现 ${s.created} 条新录播，已入队：` + s.found.map((f) => f.title).join(' / ');
    } else if (s.error) {
      el.textContent = '检查失败: ' + s.error;
    } else {
      el.textContent = '没有新的录播（已发现的录播都在任务列表里）';
    }
    // per-UP diagnostics: what was looked at and why nothing was queued
    if (Array.isArray(s.per) && s.per.length) {
      diag.innerHTML = s.per
        .map((p) => {
          const r = p.rejected || {};
          return (
            `${esc(p.name)}: 候选 ${p.candidates} → 入队 ${p.created} ` +
            `(已处理 ${r.known || 0}，不像直播 ${r.notReplay || 0}，标题不符 ${r.nameFilter || 0}) ` +
            `过滤「${esc(p.filter || 'none')}」 · 合集 ${p.seasonsChecked || 0}/${p.seasons || 0}，搜索 ${p.queries ? p.queries.length : 0} 次` +
            (p.collections && p.collections.length ? ` · 自动打开未公开的合集: ${p.collections.map((c) => esc(c.title || c.seasonId)).join('、')}` : '') +
            (p.error ? ` · 错误: ${esc(p.error)}` : '')
          );
        })
        .join('<br>');
    } else {
      diag.innerHTML = '';
    }
    refresh();
  } catch (e) {
    el.textContent = '检查失败: ' + e.message;
  }
});

// ---------- static export of the report library (deployable static site) ----------
$('site-export').addEventListener('click', async () => {
  const el = $('site-result');
  const btn = $('site-export');
  el.textContent = '生成中…';
  btn.disabled = true;
  try {
    const r = await api('/api/site/export', { method: 'POST', body: '{}' });
    el.textContent = `已生成 ${r.reports} 份报告 → ${r.dir}（${r.files} 个文件） · 预览 <a href="${r.preview}" target="_blank">${r.preview}</a>`;
    toast(`静态报告库已生成：${r.preview}`);
  } catch (e) {
    el.textContent = '生成失败: ' + e.message;
  } finally {
    btn.disabled = false;
  }
});

(async () => {
  try {
    const s = await api('/api/site/status');
    $('site-result').textContent = s.exists
      ? `已有导出（${s.reports} 份，${new Date(s.generatedAt).toLocaleString()}） · 预览 <a href="${s.preview}" target="_blank">${s.preview}</a>`
      : '未生成';
  } catch {
    /* the export is optional; ignore a failed status read */
  }
})();

// ---------- audio cache ----------
function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

async function loadCache() {
  try {
    const s = await api('/api/cache/audio');
    if (!s.exists) {
      $('cache-result').textContent = '音频目录不存在（还没有下载过音频）';
      $('cache-detail').textContent = '';
      return;
    }
    $('cache-result').textContent =
      `音频目录 ${fmtBytes(s.totalBytes)}（${s.totalFiles} 个文件） · 可清理 ${fmtBytes(s.clearableBytes)} · 保留 ${fmtBytes(s.keptBytes)} · 无主 ${fmtBytes(s.orphanBytes)}`;
    const top = (s.top || [])
      .slice(0, 6)
      .map((t) => `${t.name} ${fmtBytes(t.bytes)}（${t.status === 'done' ? '已完成' : t.status === 'kept' ? '保留' : '无主'}）`)
      .join(' · ');
    $('cache-detail').textContent =
      `ASR 缓存 ${s.fmt.asrCache} · 转录与报告 ${fmtBytes(s.transcriptBytes)} · 完成任务 ${s.doneJobs} 个${top ? ' · 最大: ' + top : ''}`;
  } catch (e) {
    $('cache-result').textContent = '缓存状态读取失败: ' + e.message;
  }
}

$('cache-clear').addEventListener('click', async () => {
  const btn = $('cache-clear');
  const restore = busy(btn, '清理中…');
  try {
    const r = await api('/api/cache/audio/clear', { method: 'POST', body: '{}' });
    toast(`已清理 ${r.removed}（${r.removedFiles} 个文件，${r.dirsRemoved} 个空目录）`);
    await loadCache();
  } catch (e) {
    $('cache-result').textContent = '清理失败: ' + e.message;
  } finally {
    restore();
  }
});

// ---------- name table (drives the name-correction pass) ----------
let nameRows = [];
let editingNameId = null;

async function loadNames() {
  try {
    nameRows = await api('/api/names');
    renderNames();
  } catch (e) {
    $('name-result').textContent = '姓名表加载失败: ' + e.message;
  }
}

function renderNames() {
  $('name-result').textContent = nameRows.length ? `姓名表 ${nameRows.length} 条` : '姓名表为空（可手动添加，或自动识别）';
  $('names').innerHTML = nameRows
    .map(
      (n) => `
      <div class="name-row" data-name-id="${n.id}">
        <span class="name">${esc(n.name)}</span>
        ${n.english ? `<span class="tag on">${esc(n.english)}</span>` : ''}
        ${n.aliases ? `<span class="tag">别名: ${esc(n.aliases)}</span>` : ''}
        ${n.mishearings ? `<span class="tag">常见错写: ${esc(String(n.mishearings).split(',').map((x) => x.trim()).filter(Boolean).slice(0, 12).join(', '))}</span>` : ''}
        ${n.note ? `<span class="mid">${esc(n.note)}</span>` : ''}
        <span class="tag ${n.source === 'user' ? 'on' : 'off'}">${n.source === 'user' ? '手动维护' : '自动识别'}</span>
        <button class="ghost" data-name-edit="${n.id}">编辑</button>
        <button class="ghost" data-name-del="${n.id}">删除</button>
      </div>`
    )
    .join('');
}

$('name-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const body = {
    name: $('n-name').value.trim(),
    english: $('n-english').value.trim(),
    aliases: $('n-aliases').value.trim(),
    mishearings: $('n-mishearings').value.trim(),
    note: $('n-note').value.trim(),
  };
  if (!body.name) return;
  try {
    if (editingNameId) await api(`/api/names/${editingNameId}`, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/names', { method: 'POST', body: JSON.stringify(body) });
    editingNameId = null;
    ['n-name', 'n-english', 'n-aliases', 'n-mishearings', 'n-note'].forEach((id) => ($(id).value = ''));
    toast('已保存姓名');
    loadNames();
  } catch (e) {
    toast('保存失败: ' + e.message);
  }
});

$('names').addEventListener('click', async (ev) => {
  const edit = ev.target.closest('[data-name-edit]');
  if (edit) {
    const n = nameRows.find((x) => x.id === Number(edit.dataset.nameEdit));
    if (!n) return;
    editingNameId = n.id;
    $('n-name').value = n.name;
    $('n-english').value = n.english || '';
    $('n-aliases').value = n.aliases || '';
    $('n-mishearings').value = n.mishearings || '';
    $('n-note').value = n.note || '';
    $('name-result').textContent = `编辑「${n.name}」，改完后点「保存姓名」`;
    return;
  }
  const del = ev.target.closest('[data-name-del]');
  if (!del) return;
  const n = nameRows.find((x) => x.id === Number(del.dataset.nameDel));
  if (!n) return;
  try {
    await api(`/api/names/${n.id}`, { method: 'DELETE' });
    editingNameId = null;
    toast(`已删除 ${n.name}`);
    loadNames();
  } catch (e) {
    toast('删除失败: ' + e.message);
  }
});

$('name-seed').addEventListener('click', async () => {
  $('name-result').textContent = '正在从主播配置与视频标题识别姓名…';
  try {
    const r = await api('/api/names/seed', { method: 'POST' });
    $('name-result').textContent = r.added.length ? `自动识别 ${r.added.length} 个姓名：${r.added.join(', ')}` : '没有识别到新的姓名（标题里没有「中文名+英文名」形式）';
    loadNames();
  } catch (e) {
    $('name-result').textContent = '识别失败: ' + e.message;
  }
});

loadNames();
loadCache();

// deep link support: /?job=7 opens that task's report directly
const deepJob = Number(new URLSearchParams(location.search).get('job'));
if (deepJob) state.selected = deepJob;

refresh();
setInterval(refresh, 5000);
