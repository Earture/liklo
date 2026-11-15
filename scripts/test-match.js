'use strict';
// Checks the per-streamer `match` filter: which of an UP's recent uploads would be queued.
// usage: node scripts/test-match.js <mid> [match] [limit]
const bilibili = require('../src/bilibili');

(async () => {
  const mid = process.argv[2] || '1290874';
  const match = process.argv[3] || '莉蔻,Liko';
  const limit = Number(process.argv[4] || 10);
  const list = await bilibili.listSpaceVideos(mid, limit);
  console.log(`found ${list.length} uploads for mid ${mid}; match terms: ${match}`);
  for (const v of list) {
    let info;
    try {
      info = await bilibili.getVideoInfo(v.bvid);
    } catch (e) {
      console.log(`${v.bvid}  (metadata failed: ${e.message.slice(0, 40)})`);
      continue;
    }
    const replay = bilibili.isReplay(info.title, '录播,直播,录像', info.duration);
    const hit = bilibili.matchesName(info.title, match);
    console.log(
      `${info.bvid}  replay=${replay ? 'Y' : 'N'}  match=${hit ? 'Y' : 'N'}  ${info.title.slice(0, 60)}`
    );
  }
  const { replays, stats } = await bilibili.findNewReplays(mid, '录播,直播,录像', new Set(), 3, match);
  console.log('would queue:', replays.map((v) => `${v.bvid} ${v.title.slice(0, 40)}`));
  console.log('stats:', JSON.stringify(stats));
})().catch((e) => console.error('ERR', e.message));
