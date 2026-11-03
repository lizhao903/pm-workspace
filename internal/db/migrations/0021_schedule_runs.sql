-- 0021_schedule_runs: 定时任务的执行记录和调度游标（TASK-03b）
--
-- 不复用 task_runs（0009）：那是「Claude Code 执行一条任务」的记录，有进程输出、退出码、工作目录，
-- 和定时任务的「到点做了什么」字段、语义都不同，混用会让开发任务的执行记录变乱（见 docs/dev-decisions.md TASK-03）。
--
-- 一行是一次执行：
--   planned_at 是计划时刻（手动执行为点按钮的时刻），定长毫秒 UTC，字符串比较即时间比较；
--   status 为 running / ok / failed / skipped（到点时已停用）/ unsupported（SOP、Agent 动作，M4 之前不支持）/ missed（服务没在跑，错过了）；
--   missed 只在 status = missed 时有意义：这一条代表连续错过了几次，错过的不补跑，只记一条；
--   object_id、ref 是建出来的任务（建任务动作成功时才有），任务删了这里保留原值。
-- 同一个定时任务、同一个计划时刻的自动执行只能有一行（部分唯一索引，手动执行不受限）：重启后不重复执行。
-- 删定时任务时执行记录一起删（外键级联），已经建出来的任务保留。
--
-- schedules.checked_at 是调度游标：这一刻之前的计划时刻都已经处理过（执行、跳过或记为错过）。
-- 为 NULL 时从 created_at 算起。

CREATE TABLE schedule_runs (
  id           TEXT PRIMARY KEY,
  schedule_id  TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  planned_at   TEXT NOT NULL,
  manual       INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL,
  text         TEXT NOT NULL DEFAULT '',
  missed       INTEGER NOT NULL DEFAULT 0,
  object_id    TEXT,
  ref          TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT
);

CREATE UNIQUE INDEX ux_schedule_runs_slot ON schedule_runs(schedule_id, planned_at) WHERE manual = 0;
CREATE INDEX idx_schedule_runs_schedule ON schedule_runs(schedule_id, planned_at);

ALTER TABLE schedules ADD COLUMN checked_at TEXT;
