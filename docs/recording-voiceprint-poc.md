# 录音声纹 POC（M5 需求 3）：说话人分离 + 声纹绑定联系人

- 日期：2026-11-10
- 目标：验证「本机 Python + FunASR/ModelScope」能否在用户 Mac（M4 / 32G）上离线完成两件事：
  1) 把一段多说话人录音分成「谁在什么时候说话」，并给转写段落标说话人；
  2) 用单独录的声纹样本注册到联系人，后续录音自动认出这个人（余弦相似度匹配）。
- 结论：**可行，POC 通过**。两个方案都跑通，合成数据上说话人分离时长准确率 97%–100%，注册声纹匹配 2/2。
  进入生产前需要 1–2 段真实会议录音校准阈值。

## 1. 环境与依赖

| 项 | 值 |
|---|---|
| 机器 | Apple M4 10 核 / 32GB，macOS（darwin） |
| Python | 3.13.2（conda），已有 torch 2.7.1 + torchaudio 2.7.1 |
| 新增 Python 包 | `funasr==1.4.24`（装在 `/tmp/m5-poc/venv`，`--system-site-packages` 复用已有 torch，venv 仅 34MB） |
| 模型（ModelScope 缓存） | `iic/speech_fsmn_vad_zh-cn-16k-common-pytorch` 4.7MB（VAD）<br>`iic/speech_campplus_sv_zh-cn_16k-common` 28MB（CAM++ 192 维声纹） |
| 合计新增磁盘 | 约 67MB（包+模型；torch 用户本机已有） |
| 网络 | 仅首次 `pip install` + 模型下载；识别/推理完全离线 |

安装命令（POC 复现用）：

```bash
python3 -m venv --system-site-packages /tmp/m5-poc/venv
/tmp/m5-poc/venv/bin/pip install funasr
# 模型由 funasr 首次调用时从 modelscope 自动下载到 ~/.cache/modelscope/hub
```

## 2. 测试数据（可复现）

脚本在 [`scripts/voiceprint-poc/`](../scripts/voiceprint-poc/)：

- `gen_audio.py`：用 macOS `say` 合成 9 轮双人对话（Tingting 女声 / Grandpa 男声，0.25s 静音拼接），
  53.6s、16k 单声道；同时合成两段注册音频（A/B 各 ~4–6s 自我介绍）。真值由拼接时长直接得出，无人工标注误差。
- `poc_diarize.py`：**方案 A**（VAD + CAM++ 分块 + 谱聚类）。
- `poc_whisper_segments.py`：**方案 B**（用 whisper 段落边界 + CAM++ + 层次聚类）。

复现：`cd scripts/voiceprint-poc && python3 gen_audio.py && /tmp/m5-poc/venv/bin/python poc_diarize.py`。

## 3. 方案 A：VAD + CAM++ 分块 + 谱聚类（推荐）

流程：`fsmn-vad` 切语音段 → 语音段按 1.5s 窗口 / 0.75s 步长切块（`funasr.models.campplus.utils.sv_chunk`）
→ 每块 CAM++ 提 192 维 embedding → FunASR `ClusterBackend`（谱聚类，自动人数，最多 4 人）→ 每个语音段一个说话人标签。

结果（53.6s 对话）：

| 指标 | 结果 |
|---|---|
| VAD 语音段 / 分块数 | 3 段（连续说话被合并）/ 69 块 |
| 聚类人数 | 2（真值 2） |
| 分块准确率 | 67/69 = **97.1%** |
| 按时长加权准确率 | **97.1%** |
| 注册声纹匹配 | **2/2**；A 与 A 簇余弦 **0.965**、与 B 簇 0.074；B 与 B 簇 **0.904**、与 A 簇 0.118 |
| 耗时 | 首次含下载+加载 44.3s；模型缓存后重跑约 8–10s（54s 音频） |

## 4. 方案 B：whisper 段落边界 + CAM++ + 层次聚类（更省事）

流程：拿 whisper 的段落时间戳（本来就用于转写）→ 每段音频提 CAM++ embedding → sklearn 层次聚类
（cosine / average / distance_threshold=0.35）→ 段落直接得到说话人标签。**不需要 VAD 模型，也不需要时间对齐**。

结果（whisper large-v3-turbo，9 段）：

| 指标 | 结果 |
|---|---|
| 段落说话人准确率 | **100%**（9/9，按时长也 100%） |
| 注册声纹匹配 | **2/2**（A 0.969 / B 0.908，错配 ≤0.08） |
| 耗时 | 7s（含模型加载），纯推理约 2s |

## 5. 重要发现

1. **whisper 模型选择会影响「能不能看到说话人」**：同一段对话里较安静的男声，
   `ggml-small` / `ggml-base` 直接漏掉了 4 个男声段落（只出 5 段女声），`ggml-large-v3-turbo` 完整出 9 段。
   长会议/多说话人场景建议 medium 或 large-v3-turbo；声纹分离本身不依赖 ASR，但**没有转写就没有段落可标**。
2. 方案 A 与方案 B 在干净合成语音上差异不大；方案 A 粒度更细（1.5s 块）、不依赖 ASR 段落质量，
   方案 B 实现最简单、天然对齐转写。**建议生产用 A 做分离 + 按时间重叠给 whisper 段落打标签**，
   实现量只比纯 B 多一个「重叠归属」函数，但更抗 whisper 并句/漏句。
3. 声纹注册匹配的区分度很好（同人 0.90–0.97，异人 0.06–0.12），相似度阈值 0.6–0.7 起比较安全；
   真实会议室远场/相似音色需要真数据校准。

## 6. 建议的 M5 落地方案（待批准后实现）

### 6.1 插件与依赖

- recording 插件升 **0.3.0**，迁移 `0003_voiceprints.sql`。
- 依赖用户本机 Python 3 + `pip install funasr`（首次约 1–2GB 若没装过 torch；本机已有 torch 时约 200MB 内）。
  设置里可配 `python_path`；模型目录可配，支持首次自动下载（modelscope）与手动放置。
- 内核：`internal/plugin/network.go` 的 `model` 组补 `modelscope.cn` / `www.modelscope.cn`（与 hf 一致）；
  sidecar 用 `process:spawn` 权限启动（已有），识别阶段不联网。

### 6.2 数据模型（迁移 0003）

```sql
-- 联系人声纹（生物特征，只有本机、只有用户主动绑定时写入）
CREATE TABLE recording_voiceprints (
  contact_id TEXT PRIMARY KEY,
  embedding  BLOB NOT NULL,      -- float32 192 维
  model      TEXT NOT NULL,      -- campplus_cn_common
  source_recording_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 每条录音的说话人
CREATE TABLE recording_speakers (
  recording_id TEXT NOT NULL,
  label        TEXT NOT NULL,    -- spk_1 / spk_2
  contact_id   TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  similarity   REAL NOT NULL DEFAULT 0,
  embedding    BLOB,             -- 该簇质心，用户绑定时写回 voiceprints
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (recording_id, label)
);
```

`recording_segments.speaker`（0001 已有）存 label；详情接口返回说话人列表（名字/联系人/相似度）。

### 6.3 流水线

- 新增 job kind `diarize`，排在转写成功之后（与自动纪要并列，可设置开关 `auto_diarize`）。
- 插件用 `go:embed` 内嵌 Python sidecar 脚本，运行时写到 `CacheDir()/recording/voiceprint/`，
  `python3 voiceprint.py diarize --input <16k wav> --out <json> --max-speakers N`，超时 10 分钟；
  输出 `[{start,end,label,embedding:base64}]`，Go 侧按时间重叠给 whisper 段落写 speaker；
  再用簇质心与 `recording_voiceprints` 做余弦匹配，≥ `match_threshold` 的自动填联系人名。
- 16k wav 复用现有 ffmpeg 转码产物（临时文件保留到 diarize 结束）。
- 失败不影响转写/纪要，只把说话人区标「未识别」，可手动重跑。

### 6.4 设置（Settings 扩 5 项）

`auto_diarize`（默认开）、`python_path`（空=python3）、`voiceprint_model_dir`（空=自动缓存）、
`max_speakers`（默认 8）、`match_threshold`（默认 0.65）。保留 `retention` 语义：声纹绑定属于联系人资料，
删录音不删声纹，界面上可解绑/删除。

### 6.5 API / 前端

- `GET /api/recording/recordings/{id}/speakers`：说话人列表（label/name/contact/similarity/段数）。
- `POST /api/recording/recordings/{id}/speakers/{label}/bind` `{contact_id}`：绑定联系人，
  把该簇质心写 `recording_voiceprints`（已有则覆盖，需确认）。
- `PATCH /api/recording/recordings/{id}/speakers/{label}` `{name}`：只改显示名（不写声纹）。
- `POST /api/recording/recordings/{id}/diarize`：手动重新识别。
- `GET /api/recording/voiceprints` + `DELETE /api/recording/voiceprints/{contact_id}`：管理已登记声纹。
- 前端详情页「说话人」区：自动识别出的联系人名/相似度、每段转写左侧彩色标签、
  「绑定到联系人 / 改名 / 重新识别」；设置页「声纹」区。
- 删除联系人时的声纹清理：联系人删除后声纹按 contact_id 失配，查询时忽略并提示重新绑定（或订阅联系人删除事件清理）。

### 6.6 验收标准

- 合成双人对话：分离准确率 ≥ 95%，注册匹配 2/2（POC 已达标）。
- 真实会议录音 1–2 段：说话人段数正确、相邻说话人切换基本正确；绑定后重跑能自动认出至少 1 人。
- 无 Python/模型时不崩：设置里明确提示「未安装/未下载」，转写与纪要不受影响。
- 全量测试 + 前端测试 + 真机（dev 实例）走通一次。

### 6.7 工作量估计

后端 1–2 天（sidecar、job、5 个接口、迁移、测试），前端 1 天（说话人区、绑定交互、设置），
联调/真机验证 0.5 天。可以按 M4a 同样方式拆给两个 teammate 并行。

## 7. 已落地（2026-11-10）

用户批准后按方案 A 实现为录音插件 0.3.0（设计 §14、落地状态 §14.10）：本机 Python sidecar + 6 条新接口 + 说话人绑定 UI + 声纹设置；dev 实例已升级并真机走通。本文记录 POC 结论不再改动。

## 8. 待你确认

1. 是否按上面方案全量实现 M5（插件 0.3.0）？
2. 本机 Python 用 conda 的 3.13 是否可接受（需要能 `pip install funasr`；本机已有 torch，新增约 34MB venv + 32MB 模型）。
   若不想动 Python 环境，我可以再评估 `sherpa-onnx`（纯 onnx、无需 torch，但中文声纹/聚类效果要另测）。
3. 能否提供 1–2 段真实会议录音（多人、有交叉更好）用于校准阈值？没有的话我先用合成数据+公开样本调，标注「需真数据复核」。

---

由 DeepSeek Harness（dsh）协助完成。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
