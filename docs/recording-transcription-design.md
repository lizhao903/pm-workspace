# 录音转写（recording）设计文档

- 状态：**实现中**（2026-11-10，M1 先落地，M2/M3 按同一契约推进）
- 需求：[docs/recording-transcription-requirements.md](recording-transcription-requirements.md)（v0.3）
- 契约：[docs/api-contract.md](api-contract.md)「录音转写插件 recording」一节
- 范围：浏览器录音 → 本机 whisper.cpp 转写 → 带时间戳文本；模型管理；设置页。M2 纪要/待办、M3 导出/归档/检索同契约内实现。

## 1. 架构

```
浏览器 (React 插件 recording)
   │  MediaRecorder → webm/opus(或 mp4/aac)
   ▼
POST /api/recording/recordings           建草稿
POST /api/recording/recordings/{id}/audio 上传原始音频（multipart）
   ▼
attachments/recording/<id>/audio.webm
   ▼  recording_jobs(kind=transcribe) 持久化队列，后台 Job 每 2s 取一条
ffmpeg → <cache>/tmp/<id>/audio16k.wav
   ▼
whisper-cli -m <models>/ggml-<model>.bin -f wav -l zh -t 8 -nfa -pp -oj -of <prefix>
   ▼  解析 <prefix>.json 的 transcription[]
recording_segments + recording_transcripts.text → 状态 transcribed
   ▼（M2）summarize job → Core.Agent().Complete(本地 Ollama 服务商) → minutes_json
   ▼（M2）待办 → Core.ObjectWriter().CreateAs(task)
   ▼（M3）导出 srt/vtt/md/txt；归档 doc / 知识库 Sync
```

关键约束：

- 音频与文本全程本机；唯一联网点是「下载模型」（`network:model`，可不用，手动放置也行）。
- 转写串行：全局只跑一个 whisper 进程，其余排队（避免抢 CPU 和内存）。同一 recording 同时只有一个 active job。
- 插件的路由、Job、审计、队列都挂在内核既有扩展点上，不需要新扩展点。

## 2. 数据模型（`internal/plugins/recording/migrations/0001_recording.sql`）

```sql
recording_settings   -- 单行 id=1，见 §8
recording_recordings -- id, title, status, engine, model, language, audio_path, audio_mime, audio_size,
                     -- duration_ms, transcript, minutes_json, minutes_model, project_id, error,
                     -- attempts, created_at, updated_at
recording_segments   -- recording_id, seq, start_ms, end_ms, text, speaker, PK(recording_id, seq)
recording_jobs       -- id, recording_id, kind, status, progress, attempts, next_run_at, last_error,
                     -- created_at, updated_at；索引 (status, next_run_at)
recording_todos      -- recording_id, todo_index, task_id, created_at, PK(recording_id, todo_index)
recording_archives   -- recording_id, target, ref_id, created_at, PK(recording_id, target)
```

- 模型不建表：是否下载好按 `<model_dir>/ggml-<name>.bin` 扫描 + 文件大小校验；下载进度只放进程内内存（重启后
  丢失，文件不完整的临时文件下次下载会覆盖）。不建表就没有「进程重启后永远停在下载中」的脏状态。

- `audio_path` 存相对数据目录的路径（`attachments/recording/<id>/audio.webm`），不存绝对路径。
- 状态机：`draft → uploaded → transcribing → transcribed → summarizing → ready`，任一步失败 `failed`（可重试）。
  M1 只到 `transcribed`/`failed`；`summarizing`/`ready` 属 M2。
- 删除录音：删本表、segments、jobs、todos、archives 记录、音频目录；已建的任务/文档/知识库篇目不删。

## 3. 后端包结构（`internal/plugins/recording/`）

| 文件 | 内容 |
|---|---|
| `plugin.json` | 清单；id `recording`，icon `mic`，core `>=1.1.0 <2.0.0` |
| `recording.go` | `Plugin`/`New`/`Manifest`/`Migrations`/`Register`（路由、Job、默认设置） |
| `migrations/0001_recording.sql` | 建表 |
| `settings.go` | Settings 结构、读/写/校验/补默认 |
| `tools.go` | whisper-cli/ffmpeg 探测、版本、模型目录、模型清单、模型下载 |
| `handlers.go` | 路由处理函数、JSON 助手、错误映射 |
| `store.go` | recordings/segments/jobs 的 DAO |
| `worker.go` | 后台任务循环：transcribe（M1）、summarize（M2） |
| `transcribe.go` | ffmpeg 转码 + whisper-cli 调用 + JSON/进度解析 |
| `minutes.go` | 纪要 prompt、调用 Agent、解析（M2） |
| `todos.go` | 待办转任务、幂等（M2） |
| `export.go` | txt/md/srt/vtt（M3） |
| `archive.go` | 归档 doc / 知识库（M3） |
| `search.go` | 搜索源数据（M3，可后补） |
| 测试 | 单测 `transcribe_test.go`、`settings_test.go`；真装真跑的集成用例 `internal/api/recording_integration_test.go`（有本机音频 + 模型时才跑） |

## 4. 接口契约（冻结，前端按此实现）

统一响应信封同内核：成功 `{data, meta?}`；失败 `{"error":{"code","message"}}`（400 validation / 404 not_found / 409 conflict / 500 internal）。
插件未安装或停用时全部 404（内核行为）。

### 4.1 `Recording` JSON

```
{
  "id": "rec_xxx", "title": "…", "status": "draft|uploaded|transcribing|transcribed|summarizing|ready|failed",
  "engine": "whisper_local", "model": "small", "language": "zh",
  "duration_ms": 0, "audio_size": 0, "audio_mime": "", "has_audio": false,
  "transcript": "", "segments": [ {"seq":0,"start_ms":0,"end_ms":2400,"text":"…","speaker":""} ],
  "minutes": null, "minutes_model": "", "todos": [], "project_id": "", "project_title": "",
  "error": "", "attempts": 0, "job": {"kind":"…","status":"pending|running|done|failed","progress":0,"attempts":0,"last_error":""} 或 null,
  "task_count": 0, "created_at": "RFC3339", "updated_at": "RFC3339"
}
```

- 列表项不带 `transcript`/`segments`（`RecordingSummary`：id/title/status/model/duration_ms/has_audio/audio_size/created_at/updated_at/project_id/project_title/error/job/task_count/has_minutes）。
- `minutes`（M2）：`{summary, decisions:[string], todos:[{title, owner_hint, due_hint, project_hint, task_id?}], risks:[string], generated_at, model}`；`todos[].task_id` 由当前映射填。
- `job`：最新一条未完成或最近完成的任务；`progress` 0–100。

### 4.2 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/recording/meta` | 工具/模型/设置/默认值汇总，见 §4.3 |
| GET | `/api/recording/recordings?status=&project_id=&q=&limit=&offset=` | 列表，按 created_at 倒序；`q` 过滤标题与转写文本；limit 默认 50、1–200 |
| POST | `/api/recording/recordings` | `{title?, project_id?, model?, language?}` 建草稿，回 201 + Recording |
| GET | `/api/recording/recordings/{id}` | Recording（含 segments），不存在 404 |
| PATCH | `/api/recording/recordings/{id}` | `{title?, project_id?, transcript?, minutes?}`，回 Recording |
| DELETE | `/api/recording/recordings/{id}` | 删录音与音频文件，回 `{data:{ok:true}}` |
| POST | `/api/recording/recordings/{id}/audio` | multipart：`audio` 文件 + `duration_ms` 可选；保存后建转写任务，回 202 + Recording |
| GET | `/api/recording/recordings/{id}/audio` | 音频流，支持 Range；没有音频 404 |
| POST | `/api/recording/recordings/{id}/transcribe` | 重跑/重试转写；已有排队任务回 409 conflict；回 202 + Recording |
| POST | `/api/recording/recordings/{id}/summarize` | M2：`{provider?, model?}` 可覆盖设置；建纪要任务，回 202 + Recording |
| POST | `/api/recording/recordings/{id}/todos/{index}/task` | M2：`{title?, project_id?, owner_id?, due_at?}`；幂等，回 `{data:{task_id, reused}}` |
| GET | `/api/recording/recordings/{id}/export?format=txt\|md\|srt\|vtt` | M3：直接返回文件流（Content-Disposition attachment） |
| POST | `/api/recording/recordings/{id}/archive` | M3：`{target:"doc"\|"kb", kb_id?, category_id?, project_id?, title?}`；回 `{data:{target, ref_id, reused}}` |
| GET | `/api/recording/settings` | Settings |
| PUT | `/api/recording/settings` | 全量设置，回 Settings；校验失败 400 |
| POST | `/api/recording/models/{name}/download` | 后台下载，回 202 + ModelInfo；未知模型 400 |
| DELETE | `/api/recording/models/{name}` | 删模型文件，回 `{data: ModelInfo}` |
| GET | `/api/recording/models` | 模型清单 + 下载状态（`meta` 里也带），供设置页刷新 |

### 4.3 `meta` 与 `ModelInfo`

```
GET /meta →
{
  "tools": {
    "whisper": {"path":"/opt/homebrew/bin/whisper-cli","version":"1.9.5","ok":true,"error":""},
    "ffmpeg":  {"path":"…","version":"7.1.1","ok":true,"error":""}
  },
  "models": [ModelInfo],
  "settings": Settings,
  "model_dir": "/…/data/cache/recording/models",
  "defaults": {"model":"small","language":"zh","threads":8}
}
```

`ModelInfo`：`{name, size, status:"missing|downloading|ready|error", progress, downloaded_at, error, path}`。

### 4.4 Settings JSON

```
{
  "default_engine": "whisper_local",
  "model": "small",              // base|small|medium|large-v3-turbo
  "model_dir": "",               // 空 = CacheDir()/models
  "whisper_path": "",            // 空 = 自动探测
  "ffmpeg_path": "",
  "language": "zh",              // whisper 语言码或 auto
  "threads": 0,                  // 0 = min(8, NumCPU)
  "default_project_id": "",
  "minutes_provider": "",        // M2：服务商 id，空 = 内核默认
  "minutes_model": "",           // M2：模型名，空 = 服务商默认
  "auto_summarize": false,       // M2
  "retention_mode": "keep",      // keep | delete_audio_after_ready（M3）
  "updated_at": "RFC3339"
}
```

校验：model ∈ 四个模型名；language ∈ whisper 支持列表（zh/en/auto/yue/ja/ko/…，见 `transcribe.go`）；threads 0–64；`model_dir`/`whisper_path`/`ffmpeg_path` 非空时存在且可执行（目录/文件），否则 400；retention ∈ 两个取值。

## 5. 转写流水线

1. ffmpeg：
   `ffmpeg -hide_banner -loglevel error -y -i <audio> -ar 16000 -ac 1 -c:a pcm_s16le <tmp>/audio16k.wav`
   失败 → job failed，错误「ffmpeg 转码失败：…」。
2. whisper：
   `whisper-cli -m <model_dir>/ggml-<model>.bin -f <tmp>/audio16k.wav -l <language> -t <threads> -nfa -pp -oj -of <tmp>/out --no-prints`
   **必须带 `-nfa`**（本机 Homebrew+Metal 开 flash attention 会慢一个数量级，见需求文档实测）。CPU 回退用 `-ng`（设置里加 `use_gpu` 字段时可切，M4）。
3. 进度：逐行读 stderr，`regexp progress = *([0-9]+)%` 更新 job.progress（节流 1s 写库）；最后一行失败时取最后 20 行当错误。
4. 结果：读 `<tmp>/out.json`：
   `{ "transcription": [ {"offsets":{"from":0,"to":2400}, "text":"…"} ] }`
   段落 text 去首尾空白，丢弃空串；`transcript` = 段落用 `\n` 连接。
5. 落库：替换 segments，更新 recording（status=transcribed、model、language），job=done，progress=100，清 tmp。
6. 重试：ffmpeg/whisper 非零退出、JSON 解析失败 → attempts+1；<3 时 `next_run_at = now + backoff(attempts)`（30s/2m/10m），否则 failed。模型文件缺失/工具缺失/权限未确认不自动重试（直接 failed 并给出可操作提示）。
7. 并发：worker 每 2s 查一条 `pending` 且 `next_run_at<=now` 的任务；跑之前置 running；同一时刻只跑一个。插件停用时 ctx 取消，子进程被 CommandContext 杀掉，任务回 pending（下次启动接着跑）。

## 6. 模型管理

| name | 文件 | 字节 | 质量参考（CER，干净 TTS） |
|---|---|---|---|
| base | ggml-base.bin | 147,951,465 | 10.9% |
| small | ggml-small.bin | 487,601,967 | 6.6% |
| medium | ggml-medium.bin | 1,533,763,059 | 4.7% |
| large-v3-turbo | ggml-large-v3-turbo.bin | 1,624,555,275 | 2.7% |

- 下载 URL：`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<name>.bin`；走 `Core.HTTP("model")`（`network:model` 组），重定向跟随。
- 下载到 `<model_dir>/.tmp-ggml-<name>.bin`，完成后校验大小与上表一致再改名 `ggml-<name>.bin`；进度只放内存（`downloads` map，0–100），刷新页面照常能拿到，进程重启后按文件重新扫描。
- 手动放置：`GET /models` / `GET /meta` 时扫描 model_dir，存在且大小正确 → status=ready。
- 删除：只允许 ready 的模型；正在下载的拒绝。
- 默认模型 `small`（用户确认先跑通）；设置页可切 turbo。

## 7. 内核改动（本功能需要的全部）

1. `internal/plugin/network.go`：新增 `network:model` 组：`huggingface.co`、`*.huggingface.co`、`hf.co`、`*.hf.co`、`hf-mirror.com`、`*.hf-mirror.com`（下载 302 到 CDN，每一跳都查清单）。
2. `internal/plugin/manifest.go` 的 `Permissions`、`docs/plugin-manifest.schema.json`、`docs/plugin-api.md` 的权限表：加 `network:model`。
3. `internal/api/server.go` 的 `limitBody`：音频上传路径（POST `/api/recording/recordings/{id}/audio`）单独放宽到 1GB，其余接口维持 2MB；插件里再包一层 MaxBytesReader。
4. `cmd/pmw/main.go`：`plugins.Add(recording.New())`。
5. `internal/api/contract_doc_test.go`：`registeredRoutes` 加 `recording.New()`；`contract_shape_test.go` 的 `contractSpecs` 登记 `RecordingSummary`、`RecordingSettings`、`RecordingModel`、`RecordingMeta`。
6. `docs/api-contract.md`：新增「录音转写插件 recording」一节（本文件 §4 的端点表）。
7. `docs/plugin-api.md`：3.1 网络域名组表格加 `network:model` 一行。
8. 前端：`frontend/src/core/shell/icons.tsx` 的 `PLUGIN_ICONS` 加 `mic`；`frontend/src/core/plugin/manifest.ts` 的 `PERMISSIONS` 加 `network:model`。
9. 前端 `PLUGIN_API_VERSION` 从 `1.0.0` 对齐到 `1.1.0`（和后端 `plugin.APIVersion`、docs/plugin-api.md 一致；之前滞后导致 core `>=1.1.0` 的插件在界面上被拦）。

## 8. 设置默认值

```go
Settings{
  DefaultEngine: "whisper_local",
  Model:         "small",
  Language:      "zh",
  Threads:       0,          // 生效值 min(8, runtime.NumCPU())
  RetentionMode: "keep",
}
```

模型目录生效值：设置非空用它，否则 `CacheDir()/models`。工具探测顺序：设置路径 → `exec.LookPath` → `/opt/homebrew/bin`、`/usr/local/bin` 常见路径（GUI 启动的进程 PATH 可能不含 Homebrew）。

## 9. 前端（`frontend/src/plugins/recording/`）

- `index.ts`：注册模块 `{id:'recording', label:'录音', path:'recording'}`、设置分节 `{key:'recording', label:'录音转写'}`、命令面板「开始录音」（导航到 `/recording`，M1）。
- 数据层：`frontend/src/core/data/recording.ts`（类型、`recordingKeys`、`recordingApi`、useQuery/useMutation，写操作成功后失效 recording 前缀；轮询：状态为 uploaded/transcribing/summarizing 时 `refetchInterval: 2000`），并在 `core/data/index.ts` 导出。
- 页面：
  - `Page.tsx`（列表 + 录音入口）：顶部「开始录音」；录音工作区（麦克风授权 → 计时/暂停/继续/停止 → 上传 → 进入转写）；录音列表（状态、时长、项目、创建时间、进度、纪要/任务标记，点击进详情）。
  - `Detail.tsx`（`/recording/:id`）：音频播放器 + 文本（段落列表，点击定位音频；可编辑全文自动保存）、状态/进度、重新转写、生成纪要（M2）、待办转任务（M2）、导出（M3）、归档（M3）、删除。
  - `SettingsPage.tsx`：工具状态、模型列表（下载/删除/进度）、默认模型、语言、线程、默认项目、纪要服务商/模型（M2）、retention（M3）。
- 路由：模块路径 `/recording/*`，详情用 `useParams` 在 Page 内分派（`/recording` 列表，`/recording/:id` 详情）。
- 样式：`recording.css`，只加前缀类（`.rec-page`、`.rec-...`），用 `core/ui` 组件（PageTitle/Button/Pill/Tag/EmptyState/LoadingState/ErrorState/Switch/Select?）。
- 约束：组件里不直接 `fetch`（lint 规则），一律走 `core/api`/`core/data`；multipart 上传在 `core/api/client.ts` 里补一个 `upload` helper（允许在 core/api 内用 fetch），或在 `core/data/recording.ts` 里用 `request` 之外的方式——**优先在 core/api/client.ts 加 `uploadFile`**，导出给数据层用。
- 录音实现：`getUserMedia({audio:true})` → `MediaRecorder`；MIME 优先级 `audio/webm;codecs=opus` → `audio/webm` → `audio/mp4` → 默认；`ondataavailable` 收集 Blob；停止后 `new Blob(chunks)`，用 FormData 上传；计时用 `performance.now()` 减暂停累计；权限失败给出明确提示（需安全上下文，127.0.0.1 或 localhost）。
- 轮询与错误：显示 job.progress；失败时展示 error 文案与「重试」按钮。

## 10. 测试

后端：
- `transcribe_test.go`：给定 fake JSON，解析段落/时间戳/空行过滤；进度正则；命令参数含 `-nfa`。
- `export_test.go`：srt/vtt 时间格式与段落顺序；md 结构。
- `settings_test.go`：校验（模型名、语言、线程、路径）、默认值、model_dir 生效值。
- `handlers_test.go`（可选）：用 mem store + httptest 测列表/详情 404/上传校验。
- 契约：`go test ./internal/api/` 的文档测试必须过（新路由写进 api-contract.md）。
- 端到端手工：dev 实例安装启用插件 → 上传 `say -v Tingting` 生成的 wav → small 模型跑通，段落非空、时间戳递增。

前端：
- `model.test.ts`：时长格式化、状态文案、srt? 不需要；`api.test.ts` 可测 URL 构造。
- `Page.test.tsx`（可选，M1 不强制）：渲染列表。

构建验证：`go build ./...`、`go test ./... -count=1`、`cd frontend && npm run typecheck && npm run lint && npm test`、`make ui` 或 `npm run build`。

## 11. M1 范围（本次交付）

必须：插件骨架 + 迁移 + 设置 + 工具/模型管理 + 录音上传 + ffmpeg/whisper 流水线 + 后台队列/进度/重试 + 列表/详情/文本编辑 + 音频播放 + 前端录音页/设置页 + 内核图标/网络组/注册 + 契约文档 + 测试。

M2（同契约实现，随后）：纪要生成（Ollama）、待办转任务、详情页对应 UI。
M3（随后）：导出、归档、搜索。
M4：云引擎、长录音断点、说话人、实时、IM 语音（不做）。

## 12. 已知限制

- 只支持本机浏览器（HTTP 127.0.0.1/localhost）录音；内网 HTTP 域名用不了麦克风。
- 转写串行，多个长录音排队；30 分钟录音 small/Metal 约 4–5 分钟。
- 首次下载模型 466MB（small）/1.5GB（turbo），需联网；手动放置同样有效。
- 说话人字段预留但不展示；实时转写不做。
- 应用退出会打断转写（任务可重试，不续跑）。
- 模型目录在 cache 下，不入备份；换机需重新下载或重新指定目录。

## 13. M4a：文件目录、纪要/SOP、置信度确认（2026-11-10 确认）

用户新增 4 项能力，分两批：**本批 M4a 做 1（重命名）、2（同目录归档 + 纪要 + SOP + 图表）、4（置信度确认 → 建任务）**；
**M5 单独做 3（声纹/说话人识别）**，引擎已定「本机 Python + FunASR/ModelScope」，实施前先做本机小样验证。

### 13.1 文件目录（每录音一个文件夹）

`attachments/recording/<id>/` 下：

| 文件 | 内容 | 何时写 |
|---|---|---|
| `audio.<ext>` | 原始音频（M1 已有） | 上传时 |
| `transcript.md` | 标题 + 时长/模型/时间头 + 全文 | 转写成功、PATCH 改全文后 |
| `minutes.md` | 纪要（摘要、结论、待办、图表用 mermaid 代码块） | 生成纪要成功后 |
| `minutes.json` | 结构化纪要（见 13.3） | 同上 |
| `diagrams/flow.mmd`、`diagrams/tree.mmd` | 流程图/树形图的 mermaid 源码 | 同上 |

写文件用 tmp + rename，失败只记日志不挡主流程（DB 是唯一真源，文件可从 DB/JSON 重新导出）。
删除录音时删整个目录。`GET /files` 现查磁盘，M1 老录音没有这些文件时补生成 transcript.md 的时机：打开详情不补，
重新生成纪要/重新转写才补（避免在读路径写盘）。「重命名」= 改标题（PATCH 已有），不改磁盘上的固定文件名。

### 13.2 纪要生成（插件内直连 Agent，可被 SOP 触发）

2026-11-10 补：两种模型调用都显式 `Thinking: plugin.ThinkingOff`——结构化 JSON 任务开着思考时 qwen3.5 对几十字转写也会生成几千 token，纪要要等好几分钟；关掉后通常十几秒。后台任务会上报进度（3 起步、45 纪要、80 候选、95 落库），失败/进程重启时 worker 启动把遗留 `running` 任务放回 `pending` 重跑，详情页显示已用时间和提示，避免一直 0% 看起来像卡死。


`POST /recordings/{id}/minutes` 与后台任务 kind `summarize` 走同一条流水线（`minutes.go`）：

1. 读设置取 provider/model（空串用默认服务商/Agent 场景默认），`Core.Agent().Complete`，超时 5 分钟。
2. 提示词要求**只输出 JSON**（模板见 13.3），带转写全文（超长按 12000 字符截断并注明）、项目清单（`Objects().List("project")` 最多 50 个）辅助匹配项目。
3. 宽松解析（去掉 ```json 围栏、截取第一个 `{` 到最后一个 `}`）；解析失败带错误重试一次（提示「只输出 JSON，不要解释」），仍失败则任务失败可重试。
4. 落 `recording_recordings.minutes_json` / `minutes_model`，写 `minutes.md` / `minutes.json` / `diagrams/*.mmd`。
5. 识别候选（项目/任务/目标）写 `recording_todos`，status=`pending`；置信度 ≥ `minutes_threshold` 的发通知（`recording.tasks_pending`）推给用户确认。
6. 状态 `summarizing → ready`；失败回 `transcribed`、任务 `failed`（可点「重新生成」）。

自动触发：设置 `auto_summarize=true` 时，转写成功后——`minutes_flow` 非空则 `Core.Runs().StartSOP(流程, {recording_id}, 关联对象)`；
为空或 SOP 没启用（`ErrNoSOPStarter`）则直接排队 `summarize` 任务（不因为 SOP 没开而失败）。

### 13.3 结构化纪要 `minutes.json`

```json
{
  "summary_md": "Markdown 摘要（含结论、风险、下一步）",
  "conclusions": ["结论 1"],
  "actions": [{"title": "任务标题", "detail": "上下文", "owner": "张三", "due": "2026-11-20", "project": "项目名", "confidence": 0.9, "kind": "task"}],
  "projects": [{"name": "项目名", "confidence": 0.86, "reason": "会上多次提到", "project_id": "可选：插件按名字匹配到的项目 id", "project_title": "可选"}],
  "goals": [{"title": "目标", "confidence": 0.8, "reason": "..."}],
  "questions": [{"question": "待用户回答的问题", "why": "为什么不确定", "confidence": 0.4}],
  "diagrams": {
    "flow": {"title": "讨论脉络", "nodes": [{"id": "n1", "label": "现状", "kind": "start"}], "edges": [{"from": "n1", "to": "n2", "label": "可选"}]},
    "tree": {"title": "项目/任务树", "root": {"label": "会议主题", "children": [{"label": "子项"}]}}
  },
  "generated_at": "RFC3339",
  "model": "qwen3.5:4b"
}
```

约束（提示词里写明、后端解析时截断/丢弃超限）：`actions` ≤ 20，`projects` ≤ 5，`goals` ≤ 5，`questions` ≤ 5；
`flow.nodes` ≤ 10、`edges` ≤ 15，`kind` ∈ start/process/decision/end；`tree` 深度 ≤ 3、每层 ≤ 8；
`confidence` 0–1。缺字段按空处理，不因单字段坏掉整份纪要。

### 13.4 置信度确认 → 建任务

`recording_todos` 从「M2 预留的幂等映射」改为候选表（迁移 `0002_minutes.sql`）：

`todo_index, kind(project|task|goal), title, detail, confidence, status(pending|confirmed|ignored), project_id, project_title, object_id, object_ref, reason, created_at, updated_at`

- 项目候选：`confirm` 时把录音挂到项目（`recording_recordings.project_id`），不建对象；AI 给的名字匹配不到已有项目时，
  confirm body 里 `project_id` 必填（前端给项目下拉）。
- 任务/目标候选：`confirm` 用 `Core.ObjectWriter().CreateAs` 建 `task`（幂等键 `recording/<录音 id>/todo/<index>`），
  `title`/`body`/`project_id`/`owner_id`/`priority`/`due_at` 可由 confirm body 覆盖；`props` 写
  `{"recording_id":..., "recording_title":..., "goal": true|false, "confidence":...}`；目标候选加 `goal=true`（先不另建类型）。
- 负责人名字先 `Core.Contacts().FindByName` 匹配，匹配不到不指派并在返回里说明。
- 确认后发通知/记审计；`ignore` 只改状态。已确认的再 confirm 回 409。
- 高置信度推送：生成候选时 `confidence >= minutes_threshold`（默认 0.7）的候选汇总发一条通知
  `recording.tasks_pending`，title 写数量、Data 带 `recording_id`、详情页高亮；低置信度和 `questions` 在详情页「需要你确认/回答」区展示。

### 13.5 SOP 集成

**SOP 节点**（`plugin.json` `provides.sop_nodes` 加两项，插件版本 0.2.0）：

| kind | Effect | 配置 | 输出 |
|---|---|---|---|
| `recording_minutes` | write | `recording`（id 或标题，支持 `{{字段}}`）、`provider`/`model` 可选 | `with(input, "minutes", {recording_id, title, summary, conclusions_count, actions_count, files})` |
| `recording_extract` | write | `recording` | `with(input, "recording_todos", {recording_id, pending_count, high_confidence_count, project_candidates, task_count})` |

节点内部用 13.2/13.4 的同一份实现，失败信息给人话（「录音 X 不存在」「还没转写」「模型返回不是 JSON」）。

**内置流程** `sop_recording_minutes`「会议纪要整理」：trigger manual，fields `recording_id`，
step1 `recording_minutes` → step2 `recording_extract`（`after: [step1]`）。后台任务每 1 分钟试写一次，写过的记
`recording_flows(flow_id, installed_at)`，用户删了不补；卸载时撤没改过的（同视频插件）。

**发起入口**：`POST /recordings/{id}/sop`（body `{flow?}`，空用设置 `minutes_flow`，再空用内置流程 id）→
`Core.Runs().StartSOP`；SOP 没启用 409，流程不存在 400。详情页「发起纪要 SOP」直接用它。

### 13.6 接口新增（冻结）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/recording/recordings/{id}/minutes` | 重新生成纪要（插件内直连 Agent），回 202 + `Recording`；没转写 400，正在生成 409 |
| POST | `/api/recording/recordings/{id}/sop` | 发起纪要 SOP `{flow?}`，回 202 `{flow, run_id}`；SOP 未启用 409，流程不存在 400 |
| GET | `/api/recording/recordings/{id}/files` | `RecordingFile[]`（`{name, kind, bytes, updated_at}` + `meta.total`） |
| GET | `/api/recording/recordings/{id}/files/{name}` | 下载文件（白名单：`transcript.md`、`minutes.md`、`minutes.json`、`diagrams/flow.mmd`、`diagrams/tree.mmd`），其它 404 |
| POST | `/api/recording/recordings/{id}/todos/{index}/confirm` | `{title?, project_id?, owner_id?, priority?, due_at?}`，回 `RecordingTodo`；已确认 409 |
| POST | `/api/recording/recordings/{id}/todos/{index}/ignore` | 回 `RecordingTodo` |

`Recording` 的 `minutes` 从 `null` 改为 `RecordingMinutes`（结构同 13.3，前端按字段渲染，未知字段忽略）；
`todos` 改为 `RecordingTodo[]`；`RecordingSummary` 加 `todos_pending`（待确认数）。`RecordingSettings` 加
`minutes_flow`、`minutes_threshold`（0–1，默认 0.7）；`auto_summarize` 语义固定为「转写完成后自动生成纪要（有流程走 SOP）」。

### 13.7 前端

- 列表页：标题行内重命名（铅笔→输入→PATCH）；「待确认 N」徽标、纪要已有徽标。
- 详情页新增三块：
  - 「文件」：`GET /files` 列表 + 下载链接（`/files/{name}`），没有时提示「生成纪要后出现」。
  - 「纪要」：`minutes.summary_md` 用 `core/ui/Markdown` 渲染；结论列表；流程图/树形图用插件内 SVG 组件按 13.3 JSON 画
    （不引 mermaid 依赖；`.mmd` 只作下载）；「生成纪要 / 发起纪要 SOP / 重新生成」按钮与进度。
  - 「待你确认」：候选卡片（标题、置信度进度条、项目、负责人），按钮 确认（可改项目/负责人/标题）/忽略；
    `questions` 和低置信度项列在「需要你补充」区。
- 设置页：自动生成开关、SOP 流程（文本输入流程 id 或名称，空=插件内直连）、置信度阈值滑杆、
  纪要服务商/模型（文本，留空用默认服务商与默认模型；长会议建议 4B 以上，如 `qwen3.5:4b`）。

### 13.8 测试

- 单元：`minutes_test.go`（JSON 解析宽松/截断/坏字段）、`todos_test.go`（confirm/ignore/幂等/404/409）、`sopflow_test.go`（模板合法、节点声明守卫）。
- 集成 `internal/api/recording_minutes_integration_test.go`：真插件 + 假 Agent（`Registry.SetAgent` 注入口）→ 转写完成后生成纪要
  → 文件存在 → 高置信度通知 → confirm 建出 task 并挂项目 → 幂等再 confirm 409 → SOP 节点流程（用假 SOP 引擎或真 sop 插件）跑通。
- 手动：真 Ollama `qwen3.5:4b` 生成一份纪要，看 JSON 合法性与图表 JSON。

### 13.9 落地状态（2026-11-10）

- 已实现（插件 0.2.0）：迁移 `0002_minutes.sql`、6 个新接口、纪要/候选流水线、SOP 节点与内置流程、文件目录、删除目录、
   自动纪要（SOP 优先，SOP 未启用回退直连）、前端列表/详情/设置全部改版。
- 已装 0.1.0 的实例升级：管理接口 `POST /api/plugins/recording/upgrade`（会先备份再跑迁移），升级后才有纪要相关表/列。
- 已验证：`go test ./...`（契约测试 + `TestRecordingPluginM1E2E/ModelDownload/MinutesE2E`）、前端 typecheck/1890 测试、生产构建；
  真 Ollama 冒烟 `qwen3.5:0.8b`（约 27s）与 `qwen3.5:4b`（约 3.5min）都产出可解析 JSON；真实实例库 0.1.0→0.2.0 升级通过。
- 未做：M2 模型管理增强、M3 导出/归档/搜索、M5 声纹（下一批）。

## 14. M5：说话人分离与声纹（0.3.0，2026-11-10 批准）

需求 3：声纹绑定联系人、后续录音自动识别并标记说话人。引擎定为本机 Python + FunASR/ModelScope；
POC 结论与方案见 `docs/recording-voiceprint-poc.md`（方案 A：VAD + CAM++ 分块 + 谱聚类，合成双人对话时长准确率 97%，注册匹配 2/2）。

### 14.1 依赖与安装

- 本机 `python3`（conda 或系统均可），`pip install funasr`（首次装会带 torch；本机已有 torch 时约 200MB 内）。
- FunASR 模型首次自动从 ModelScope 下载到 `~/.cache/modelscope/hub`：`fsmn-vad` 4.7MB + `cam++` 28MB；
  可设置 `voiceprint_model_dir` 指定目录（支持手动放置）。识别阶段完全离线。
- 插件权限不变（`process:spawn` 已有）；模型下载发生在 Python sidecar，内核网络白名单不拦它，
  文档/设置里写明「首次下载需要联网，之后离线」。

### 14.2 数据模型（`migrations/0003_voiceprints.sql`）

```sql
-- 每条录音识别出的说话人；embedding 是该簇质心（float32 192 维），用户绑定时写进 voiceprints
CREATE TABLE recording_speakers (
  recording_id TEXT NOT NULL,
  label        TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  contact_id   TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  similarity   REAL NOT NULL DEFAULT 0,
  detected     INTEGER NOT NULL DEFAULT 0,
  embedding    BLOB,
  model        TEXT NOT NULL DEFAULT '',
  segments     INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (recording_id, label)
);

-- 联系人声纹：一条联系人一条，可来自任意一次录音的说话人绑定
CREATE TABLE recording_voiceprints (
  contact_id          TEXT PRIMARY KEY,
  embedding           BLOB NOT NULL,
  model               TEXT NOT NULL,
  source_recording_id TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
```

`recording_segments.speaker`（0001 已有）存 label；删录音连带删 `recording_speakers`，不删已登记的声纹。

### 14.3 Python sidecar 协议

- 插件用 `go:embed` 内嵌 `voiceprint.py`，运行时写到 `CacheDir()/recording/voiceprint.py`。
- 调用：`<python> <script> --input <16k wav> --out <json 路径> [--model-dir <dir>] [--max-speakers N]`，
  工作目录随便，stdout/stderr 收进日志（各截断 4000 字）；超时 10 分钟。
- 退出码：`0` 成功；`3` 缺依赖（stderr 有中文提示，插件把原文写进 `job.last_error`）；其它为失败。
- `--out` JSON（插件解析，内部协议，不进契约文档）：
  ```json
  {"model":"campplus_cn_common","dim":192,
   "speakers":[{"label":"spk_1","embedding":"<base64 小端 float32 x192>",
                "segments":[[start_ms,end_ms],...]}]}
  ```
  `segments` 是合并后的连续说话段（相邻同 label 块合并，重叠取并集）；Go 侧按时间重叠给 whisper 段落分配 label，
  label 以 `spk_N` 按首次出现顺序重排；要求 `dim==192`、embedding 长度匹配，否则整次失败。
- 所有模型路径/参数由 Go 传，Python 不读插件设置；日志/错误不落用户数据目录之外。

### 14.4 流水线

- 转写成功写 `transcript.md` 后：`auto_diarize` 为真且有段落 → 排 `diarize` job（在自动纪要之前排，同一条 worker 串行跑）。
- `runDiarizeJob`：`convertToWav` 复用现有 ffmpeg 转码 → 跑 sidecar → 解析 → 按段落起止时间取重叠最大的 label
  → `replaceSegments`（保留 text，写 speaker）→ 重算各说话人段落数/总时长/质心（sidecar 给的）→
  与 `recording_voiceprints` 逐一算余弦，最高且 ≥ `match_threshold` 时写 `contact_id/contact_name/detected` →
  整表替换 `recording_speakers`。**失败只把 job 标 failed 写 last_error，不改录音 status**（转写/纪要不受影响），
  详情页说话人区显示可重试。
- `POST /recordings/{id}/diarize`：手工重跑（没音频/没段落 400，已有 pending/running diarize 任务 409），
  202 + `Recording`。
- 说话人 label 稳定性：每次重跑按首次出现顺序重排；已手动改过的 `name` 在重跑时按「相同联系人/相同 embedding 最近质心」
  尽量保留（实现上简单做：重跑后若旧 row 的 label 质心与新 row 质心余弦 ≥ match_threshold 则继承 name/contact 绑定；
  否则丢弃重来。POC 阶段先做「重跑重置 name、保留自动匹配」，避免过度设计）。

### 14.5 声纹匹配与绑定

- 余弦相似度（分量已归一化也可直接用点积）；维度/模型不一致的声纹跳过并日志。
- 绑定（`POST /speakers/{label}/bind {contact_id}`）：校验联系人存在 → 把该说话人质心写入/覆盖 `recording_voiceprints`
  （`source_recording_id` 记本条录音）→ 该录音 speaker 行写 `contact_id/contact_name`，`similarity=1`、`detected=false`。
  同一条录音重复绑定不同联系人即「改绑」，覆盖声纹；已绑定状态下另一联系人绑同一说话人视为覆盖，前端需确认。
- 改名（PATCH `{name}`）只改显示名，不动声纹。
- 视图 `name` 优先级：用户改的名字 > 联系人现名（查不到用绑定快照）> 「说话人 N」。
- `GET /voiceprints` 返回 `Voiceprint[]`，联系人已删的条目照常返回（contact_name 用快照/空串），前端提示可删。

### 14.6 设置（新增 5 项，见契约 `RecordingSettings`）

`auto_diarize`（默认 true）、`python_path`（空=python3）、`voiceprint_model_dir`（空=默认缓存）、
`max_speakers`（1–16，默认 8；0/空按默认 8 处理）、`match_threshold`（0–1，默认 0.65；0 原样保留）。

### 14.7 前端

- 详情页「说话人」区（在录音信息/转写之后）：每个说话人一行——彩色圆点 + 显示名 + 联系人/相似度徽标 +
  段落数/总时长 + 操作（改名、绑定/改绑联系人、重新识别）；识别中显示进度（job.kind=diarize）。
- 转写段落左侧显示说话人彩色标签（滚动时和段落同色，点标签可筛选/高亮可选）。
- 绑定弹层：联系人下拉（按名字搜），显示当前声纹来源录音；已有声纹时提示「会覆盖原声纹」。
- 设置页「声纹」区：自动识别开关、Python 路径、模型目录、最多人数、匹配阈值滑杆。
- 列表页可选徽标「N 位说话人」（speaker_count > 0 时）。

### 14.8 测试

- 单元：sidecar JSON 解析（base64/dim/坏数据）、时间重叠归属、余弦匹配阈值边界（0/1）、settings 校验（max_speakers 1–16、
  match_threshold 0 合法）、说话人视图 name 优先级、重跑重置/继承规则。
- 集成 `internal/api/recording_diarize_integration_test.go`（Lead）：装启用插件 → 设置 `python_path` 指向一个**假 Python 脚本**
  （固定输出 2 个说话人 JSON，含确定性 embedding）→ 真 whisper 转写真实测试音频 → 等 diarize 自动跑完 →
  段落有 `spk_1/spk_2`、`speakers` 2 条 → 建联系人 → bind → `GET /voiceprints` 有记录 → 重跑 diarize 自动匹配
  （similarity 1、detected=true）→ 改名 → 删除声纹 → 缺 Python 场景任务失败但录音 status 不变。
- 手动：真 funasr 在真实会议录音上跑一次，看分段/认人效果（需要用户提供样本）。

### 14.9 已知限制

- 真实会议室远场、相似音色、重叠说话需要真数据校准阈值；POC 只验证了干净合成语音。
- 说话人分离质量依赖 VAD/聚类，人数上限由 `max_speakers` 兜底；超过上限会合并最近质心。
- Python/torch 依赖较重（本机已有 torch，新增 funasr+模型约 100–200MB）；没装时功能降级为「未识别」，不影响转写/纪要。
- whisper 模型漏句（small/base 对较轻声音）会缺段落，说话人区可能少人；多说话人场景建议 medium/turbo。

### 14.10 落地状态（2026-11-10）

已实现，插件 0.3.0（dev 实例已从 0.2.0 升级，迁移 `0003_voiceprints.sql` 已应用，路由 26 条）。

- 后端：`voiceprint.py`（go:embed，VAD → sv_chunk → CAM++ → 谱聚类）、`voiceprint.go`（sidecar 调度/解析/重叠归属/余弦匹配/继承/失败处理）、
  `store.go` 说话人与声纹 CRUD、`worker.go` 自动 diarize（排在自动纪要之前）、`handlers.go` 6 条新路由、`settings.go` 5 项设置；
  单测约 30 条（解析/归属/阈值/设置/继承/失败不改状态）。
- 前端：`Speakers.tsx` 说话人区（改名/绑定覆盖提示/删除声纹/识别进度与重试）、`Detail.tsx` 段落说话人标签、
  `SettingsPage.tsx` 声纹设置、列表页说话人徽标，数据层与测试同步。
- 验证证据：
  - 真 FunASR（合成双人对话 53.6s，large-v3-turbo 转写）：识别 2 人，时长 28.56s / 20.94s 与真值吻合，9 段全部标上说话人。
  - `TestRecordingPluginDiarizeE2E`（假 Python + 真 whisper）：自动分离 → 段落标签 → 绑定联系人写声纹 → 重跑相似度 1 自动认人 → 改名 → 删声纹 → 坏 Python 仅任务失败、录音状态不变，PASS。
  - dev 实例真机走通：上传双人对话 → 自动识别 2 人（`spk_1`/`spk_2` 交替 9 段）→ 绑定联系人 → 重跑自动匹配（similarity=1、detected=true）→ 改名 spk_2。
  - `go build ./...`、`go vet`、`go test ./internal/plugins/recording/`、契约三条测试、`go test ./internal/api -run 'TestRecordingPlugin...'` 通过；
    `go test ./...` 在本机并行负载下 `internal/plugins/im` / `internal/plugins/sop` 偶发失败，单包重跑通过（既有瞬态，与 M5 无关）。
  - 前端 `npm run typecheck`、oxlint 改动文件 0 告警、`vitest run src/plugins/recording src/core/data`（171 条）与全量 vitest（1912 条）通过、`make frontend` 重新构建嵌入。
- 升级注意：已有安装需 `POST /api/plugins/recording/upgrade`（或在插件页点升级）应用 0003 迁移；之后在设置「声纹」区填 Python 路径
  （如 `/tmp/m5-poc/venv/bin/python`）并保持「自动识别」开启。`max_speakers=0` 视为未填（默认 8），1–16 之外 400。
- 未做：M2 模型管理增强、M3 导出/归档/搜索；真实会议录音（远场/交叉说话）尚未用于校准阈值；POC 脚本保留在 `scripts/voiceprint-poc/`，生产不依赖。

---

由 DeepSeek Harness（dsh）协助完成。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
