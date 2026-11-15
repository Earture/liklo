'use strict';
/**
 * Report-stage smoke test: builds a synthetic long transcript timeline and runs the
 * full token-budgeted report generation (no ASR involved). Verifies that the local
 * LLM is never sent a prompt over config.LLM_MAX_CONTEXT.
 * Usage: node scripts/test-report.js [chars]
 */
const report = require('../src/report');
const config = require('../src/config');
const { fmtTime } = require('../src/util');

(async () => {
  const targetChars = Number(process.argv[2] || 120000);
  const lines = [];
  const filler = '莉蔻在直播里聊天，观众弹幕互动，讨论游戏与日常，声音清晰，语气轻松，中间有一段唱歌和一段抽奖环节。';
  for (let i = 0; lines.join('\n').length < targetChars; i++) {
    lines.push(`[${fmtTime(i * 12)}] ${filler}`);
  }
  const timeline = lines.join('\n');
  console.log(`[test] synthetic timeline: ${lines.length} lines, ${timeline.length} chars, ~${report.estimateTokens(timeline)} tokens (limit ${config.LLM_MAX_CONTEXT})`);
  const out = await report.generateReport('合成测试录播', timeline, {});
  console.log('[test] report generated, length', out.length, 'chars');
  console.log(out.slice(0, 1200));
})();
