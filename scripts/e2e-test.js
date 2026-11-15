'use strict';
// End-to-end smoke test: add streamer -> submit a 录播 url -> poll until done.
// Usage: node scripts/e2e-test.js [videoUrl]
const BASE = process.env.LIKLO_BASE || 'http://localhost:3200';

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${typeof data === 'string' ? data.slice(0, 400) : JSON.stringify(data).slice(0, 400)}`);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const url = process.argv[2] || 'https://www.bilibili.com/video/BV1qXJQ64EA6';
  console.log('health:', await api('GET', '/api/health'));

  const s = await api('POST', '/api/streamers', {
    url: 'https://space.bilibili.com/1290874/upload/video',
    monitor: true,
  });
  console.log('streamer:', JSON.stringify(s));

  const job = await api('POST', '/api/jobs', { url, streamerId: s.mid });
  console.log('job created:', job.id, job.title);
  if (job.status === 'error') {
    const retried = await api('POST', `/api/jobs/${job.id}`);
    console.log('retried job:', retried.status);
  }

  let last = null;
  for (let i = 0; i < 1200; i++) {
    const j = await api('GET', `/api/jobs/${job.id}`);
    if (JSON.stringify(j) !== JSON.stringify(last)) {
      last = j;
      console.log(`[${new Date().toISOString()}] status=${j.status} stage=${j.stage || ''}`);
    }
    if (j.status === 'done' || j.status === 'error') break;
    await sleep(3000);
  }

  if (!last || last.status !== 'done') {
    console.log('FAILED:', JSON.stringify(last));
    process.exit(1);
  }
  console.log('transcript chars:', (last.transcript || '').length);
  console.log('report preview:\n', (last.report || '').slice(0, 1500));
  const segs = (last.transcript || '').slice(0, 400);
  console.log('transcript head:\n', segs);
})().catch((e) => { console.error(e); process.exit(1); });
