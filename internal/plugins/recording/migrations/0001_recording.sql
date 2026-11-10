-- 0001_recording: 录音转写插件的表（M1）。
--
-- recording_recordings 一条录音一行：原始音频在 attachments/recording/<id>/ 下，audio_path 存相对数据目录的
-- 路径（不存绝对路径，换机器/换目录还能用）。status 是状态机：
-- draft → uploaded → transcribing → transcribed → summarizing → ready，任何一步失败变 failed（可重试）。
-- transcript 是段落拼起来的全文（可编辑），段落原始时间戳在 recording_segments。
--
-- recording_jobs 是持久化后台队列：kind 现在只有 transcribe（纪要 summarize 在 M2 加），
-- status 是 pending / running / done / failed。worker 每 2 秒取一条到期的 pending 任务跑，
-- 插件停用或进程退出时任务留在库里，下次启用接着跑。attempts 是已尝试次数，next_run_at 是下次可以跑的时间。
--
-- recording_todos 是待办转任务的幂等映射（M2）：同一录音的第 index 条待办只建一次任务。
-- recording_archives 记归档到文档/知识库的结果（M3），重复归档返回已有 ref，不再建。
--
-- 模型文件不建表：是否下载好按模型目录里的文件扫描（recording_models 只记下载进度的话，进程重启会留下
-- 永远「下载中」的脏状态，不如不存）。

CREATE TABLE recording_settings (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  default_engine     TEXT NOT NULL DEFAULT 'whisper_local',
  model              TEXT NOT NULL DEFAULT 'small',
  model_dir          TEXT NOT NULL DEFAULT '',
  whisper_path       TEXT NOT NULL DEFAULT '',
  ffmpeg_path        TEXT NOT NULL DEFAULT '',
  language           TEXT NOT NULL DEFAULT 'zh',
  threads            INTEGER NOT NULL DEFAULT 0,
  default_project_id TEXT NOT NULL DEFAULT '',
  minutes_provider   TEXT NOT NULL DEFAULT '',
  minutes_model      TEXT NOT NULL DEFAULT '',
  auto_summarize     INTEGER NOT NULL DEFAULT 0,
  retention_mode     TEXT NOT NULL DEFAULT 'keep',
  updated_at         TEXT NOT NULL
);

CREATE TABLE recording_recordings (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL,
  engine        TEXT NOT NULL DEFAULT 'whisper_local',
  model         TEXT NOT NULL DEFAULT '',
  language      TEXT NOT NULL DEFAULT '',
  audio_path    TEXT NOT NULL DEFAULT '',
  audio_mime    TEXT NOT NULL DEFAULT '',
  audio_size    INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  transcript    TEXT NOT NULL DEFAULT '',
  minutes_json  TEXT NOT NULL DEFAULT '',
  minutes_model TEXT NOT NULL DEFAULT '',
  project_id    TEXT,
  error         TEXT NOT NULL DEFAULT '',
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX recording_recordings_by_created ON recording_recordings(created_at DESC);

CREATE TABLE recording_segments (
  recording_id TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  start_ms     INTEGER NOT NULL,
  end_ms       INTEGER NOT NULL,
  text         TEXT NOT NULL,
  speaker      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (recording_id, seq)
);

CREATE TABLE recording_jobs (
  id           TEXT PRIMARY KEY,
  recording_id TEXT NOT NULL,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  progress     INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_run_at  TEXT NOT NULL,
  last_error   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX recording_jobs_by_status ON recording_jobs(status, next_run_at);

CREATE TABLE recording_todos (
  recording_id TEXT NOT NULL,
  todo_index   INTEGER NOT NULL,
  task_id      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (recording_id, todo_index)
);

CREATE TABLE recording_archives (
  recording_id TEXT NOT NULL,
  target       TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (recording_id, target)
);
