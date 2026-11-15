# liklo — B站录播 → 音频 → 语音识别 → 内容报告

把 B 站（bilibili）的直播录像自动处理成一份可读的「内容报告」：

```
UP 主页 / 录播链接
      │
      ▼
  1. yt-dlp 只下载音频（-f ba）
      │
      ▼
  2. 切分成 ≤ 5 分钟片段，逐段（严格串行）送 ASR，按时间偏移合并成完整带时间戳的转录
      │
      ▼
  3. 本地 LLM 生成报告：内容概括 / 名场面亮点（带起始时间戳）/ 辛辣锐评
      │
      ▼
  4. 姓名修正（程序扫描候选 + LLM 确认 + 代码替换）
      │
      ▼
  5. 网页展示：时间戳可点击，PC 跳转 `?t=<秒>`，手机端 B站 app 跳转 `start_progress=<毫秒>`
```

**零依赖**：只用 Node 内置模块（需要 Node 22+，因为 `src/db.js` 用 `node:sqlite`）。没有 npm 依赖，没有框架。

---

## 功能

| 功能 | 说明 |
| --- | --- |
| **自动发现录播** | 粘贴 UP 主页或 mid，开启监控后每 10 分钟检查最新上传；用 B站 原生接口（合集 `seasons_series` / `seasons_archives_list` / 合集详情 / WBI 搜索）找录播，时长 + 标题关键词判定是不是「直播录像」 |
| **只抓指定主播** | 一个频道里有多位 VTuber 时，设置「标题必须包含」关键词（如 `莉蔻,Liko`），只有命中标题的录播才入队；文件名用的英文名也从标题推导 |
| **任务队列** | 下载 → 切分 → 逐段转写（显示 `i/n`）→ 生成报告；可取消、可重试；已完成的 ASR 片段缓存复用，断点续跑 |
| **姓名修正** | ASR 常把人名听错（克罗雅 → 克朗 / 克里亚）。程序先按编辑距离找候选，再由本地 LLM 判断哪些确实是人名误写，最后由代码替换（报告和带时间戳的转录都修正）。修正依据始终来自原始 ASR 文本，可反复重跑而不累积错误 |
| **静默段处理** | 无说话内容的片段（开场等待、中场休息、纯音乐）合并成一条「静默 00:00 – 05:04（无人说话）」，既减少送 LLM 的 token，也避免模型在静音处编造事件 |
| **报告库** | `/reports` 列出所有已完成报告，可搜索、按日期 / 时长排序，下载 Markdown，展开带时间戳的转录 |
| **公开只读页** | 独立端口（默认 3210）：只有浏览 / 搜索 / 按主播过滤 / 展开 / 下载 Markdown / 分享直链，没有任何编辑或任务管理 |
| **静态导出** | 把整个报告库渲染成自包含的静态站点（`liklo-site/`：首页 + 每份报告一页 + Markdown 导出 + 样式），整目录上传到任意静态托管即可，不需要后端。每生成一份新报告自动重新导出 |
| **缓存清理** | 后台「缓存与存储」卡片显示音频占用，一键删除已完成任务的音频和切分中间文件（转录、ASR 缓存、报告不动） |

---

## 环境要求

- **Node 22+**（用到 `node:sqlite`；本仓库的 `start.bat` 指向一个便携 Node 运行时，改成你自己的 `node` 路径即可）
- **yt-dlp**、**ffmpeg**、**ffprobe** 可执行文件（默认找 `runtime/yt-dlp.exe` 等，可用 `LIKLO_YTDLP` / `LIKLO_FFMPEG` / `LIKLO_FFPROBE` 指向系统安装）
- 一个 **OpenAI 兼容的 ASR 服务**（本项目实测用 MOSS-Transcribe-Diarize，返回 `verbose_json` 的 `segments`）
- 一个 **本地 LLM**（OpenAI 兼容接口，例如 llama.cpp / Ollama 等；报告生成与姓名确认都靠它）

仓库里**不包含**：`data/`（数据库、音频、转录、ASR 缓存）、`liklo-site/`（生成的静态站点）、`runtime/` 里的 yt-dlp / ffmpeg 二进制、以及任何 API Key。

---

## 快速开始

```bash
# 1. 服务地址与 Key（也可以之后在页面的「服务配置」卡片里改）
export ASR_BASE=http://127.0.0.1:8000/v1
export LLM_BASE=http://127.0.0.1:8080/v1
export ASR_API_KEY=...
export LLM_API_KEY=...

# 2. 启动（主服务 3200，只读公开页 3210，静态预览 3120）
node src/server.js
node src/public-server.js      # 可选：只读报告页

# 3. 打开 http://localhost:3200
```

Windows 上直接 `start.bat`（它会先清理中断任务残留，再启动两个服务）。

首次运行会自动创建 `data/liklo.db`、`data/audio/`、`data/asr-cache/`。

---

## 配置

页面上的「服务配置」卡片可以直接改 ASR / LLM 地址、模型和 Key，写入 `data/settings.json`，**优先于环境变量和内置默认**；「恢复默认」删除该文件。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LIKLO_PORT` | `3200` | 主服务 |
| `LIKLO_PUBLIC_PORT` | `3210` | 只读公开报告页 |
| `LIKLO_PUBLIC_HOST` | `0.0.0.0` | 改成 `127.0.0.1` 则只本机可访问 |
| `LIKLO_SITE_DIR` / `LIKLO_SITE_PORT` | `liklo-site/` / `3120` | 静态导出目录与本地预览端口 |
| `LIKLO_YTDLP` / `LIKLO_FFMPEG` / `LIKLO_FFPROBE` | `runtime/` 下同名文件 | 外部工具路径 |
| `LIKLO_COOKIE` | `cookies.txt` | B站 cookie jar（页面可以粘贴导入，存到 `data/cookies.txt`） |
| `ASR_BASE` | `http://127.0.0.1:8000/v1` | ASR 服务 |
| `ASR_API_KEY` | 空 | 服务不需要 Key 时留空即可 |
| `ASR_MODEL` | `MOSS-Transcribe-Diarize-q5` | 有些服务忽略 `model` 字段，只是界面显示 |
| `ASR_TIMEOUT_MS` | `2400000` | 单个片段的最长等待（首次请求要加载模型，给足时间） |
| `LLM_BASE` | `http://127.0.0.1:8080/v1` | 本地 LLM |
| `LLM_API_KEY` | 空 | 同上 |
| `LLM_MAX_CONTEXT` | `0` | 0 = 自动读取真实上下文窗口；填正数则手动固定 |
| `MAX_SEGMENT_SECONDS` | `300` | 送 ASR 的单个片段长度（严格一段一段处理） |
| `MONITOR_INTERVAL_MS` | `600000` | 监控间隔 |
| `MONITOR_LIMIT` | `3` | 每个 UP 每轮最多入队几条 |
| `MIN_REPLAY_SECONDS` | `1200` | 短于此的上传视为切片，不是直播 |
| `LIKLO_DATA` | `data/` | 数据目录 |
| `LIKLO_SITE_AUTO` | `1` | 设为 `0` 关闭「每生成报告自动重新导出静态站点」 |

完整列表见 `.env.example`。

---

## 目录

```
src/            流水线
  bilibili.js    B站 接口：合集 / 搜索 / 录播判定 / WBI
  audio.js       yt-dlp 下载 + ffmpeg 切分
  transcribe.js  ASR 调用、时间轴、静默段、片段缓存
  report.js      分段报告生成、时间戳归一化、锐评质量检查
  names.js       姓名表 + 候选扫描 + LLM 确认 + 替换
  pipeline.js    任务队列、阶段状态、取消 / 重试 / 删除
  monitor.js     定时检查监控的 UP
  db.js          SQLite（node:sqlite）
  server.js      主服务 + API（3200）
  public-server.js  只读报告页（3210）
  staticsite.js  静态导出
  cache.js       音频占用统计与清理
public/         管理界面、报告库、只读页
scripts/        清理残留、重建转录、只生成报告、测试脚本
docs/           实现细节（长直播分段、姓名修正、静默段、已知问题）
静态网站标题图.png  静态导出首页的标题横幅（staticsite.js 自动压缩成 assets/title.webp）
```

## API（主服务）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 + 模型信息 |
| GET/POST | `/api/streamers` | 列出 / 添加主播 |
| GET/POST | `/api/jobs` | 列出任务（分页 `?limit=20&offset=0&status=done`）/ 提交任务 |
| POST | `/api/jobs/:id/cancel` · DELETE `/api/jobs/:id` | 取消 / 删除任务 |
| POST | `/api/jobs/:id/report` | 只用缓存转录重新生成报告 |
| POST | `/api/jobs/:id/transcribe` | 删除转录与 ASR 缓存，重新转写 |
| GET/POST | `/api/names` | 姓名表 |
| GET | `/api/cache/audio` · POST `/api/cache/audio/clear` | 音频占用统计 / 清理已完成任务的音频 |
| POST | `/api/site/export` | 导出静态报告库 |

## 实现细节

长直播的分段报告策略、时间戳为什么不会越界、姓名修正的两步流程、静默段如何统计、以及实测性能与已知问题，都在 [docs/实现细节.md](docs/实现细节.md)。

## License

MIT
