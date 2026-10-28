-- 0020_schedules: 定时任务定义（TASK-03a）
--
-- 一行是一个定时任务：按规则到点做一件事——建一条任务、执行一个 SOP、或者让一个 Agent 去做。
-- 本迁移只存定义；调度执行和执行记录归 TASK-03b，需要时另加表或列。
--
-- rule 是 JSON：{freq, time, weekdays, day, date, cron}，freq 为 once / daily / weekdays / weekly / monthly / cron，
-- 时间按服务所在机器的本地时区理解（见 internal/schedule）。
-- action 是 JSON：{kind, ...}，kind 为 task / sop / agent，其余字段随 kind 不同。
-- 下次执行时间不落库，读的时候按规则现算。
-- created_at、updated_at 用定长毫秒 UTC（2006-01-02T15:04:05.000Z）。
-- 表名不带下划线：插件表都是「插件 id_」开头，不会撞上。

CREATE TABLE schedules (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  rule        TEXT NOT NULL DEFAULT '{}',
  action      TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_schedules_created ON schedules(created_at);
