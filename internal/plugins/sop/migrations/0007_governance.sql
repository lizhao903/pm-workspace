-- 0007_governance: 流水线治理（AUTO-12）
--
-- sop_claude_usage 是 Claude Code 节点每发起一次记一行（账本），按需求（任务）累计次数和时长，超了上限暂停：
--   id 是那次 Claude Code 运行的 id（内核给的，不另起前缀）；run_id、step、attempt 是哪次执行的哪一步第几次；
--   task_id 是这一步配的关联任务（没配为空串）；budget_key 是按谁算预算：有任务按任务 id，没有按顶层执行 id；
--   started_at / ended_at 是这次运行的起止，没结束 ended_at 为 NULL；status 是 running / done / failed / canceled。
-- 步骤被退回、重试后原来那行留着，所以重试、回退的每一轮都算在需求的预算里，流水线时间线也从这里取历次执行。
--
-- sop_run_steps.hold 是这一步因为超出上限被暂停的记录（JSON：kind、reason、since、released、released_at、attempt），没暂停过为 NULL；
-- 人点「继续」放行后 released 为真，attempt 是放行的那一次尝试，同一次尝试不再拦。

CREATE TABLE sop_claude_usage (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  step       TEXT NOT NULL,
  attempt    INTEGER NOT NULL DEFAULT 0,
  task_id    TEXT NOT NULL DEFAULT '',
  budget_key TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  status     TEXT NOT NULL DEFAULT 'running'
);

CREATE INDEX sop_claude_usage_by_key ON sop_claude_usage (budget_key, started_at);
CREATE INDEX sop_claude_usage_by_run ON sop_claude_usage (run_id, step);

ALTER TABLE sop_run_steps ADD COLUMN hold TEXT;
