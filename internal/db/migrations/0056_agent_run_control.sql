-- 0056_agent_run_control: Agent 触发执行可控（P0-O2）
--
-- 触发式执行要能停止、重试，并记下这次交给 Agent 的提示词：
--   1) status 增加 canceled：手动停止的执行记为取消，不是失败（服务退出没跑完仍记 failed）；
--   2) 新增 prompt：保存这次执行交给 Agent 的第一句话，重试时原样再用；旧行没有存过，为空串。
--
-- SQLite 的 CHECK 约束不能直接改，按重建表的办法：建新表、复制数据、删旧表、改名，再重建索引。
-- 唯一索引 (agent_id, event_key) 是部分索引，只在 event_key 非空时生效；重试的新执行 event_key 为空，不受它约束。
-- 0036 里的 idx_agent_tool_calls_run 建在 agent_tool_calls 上，不随 agent_runs 重建，保持不动。

CREATE TABLE agent_runs_new (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  trigger_kind  TEXT NOT NULL CHECK (trigger_kind IN ('task', 'im', 'schedule')),
  trigger       TEXT NOT NULL DEFAULT '',
  source_id     TEXT NOT NULL DEFAULT '',
  event_key     TEXT NOT NULL DEFAULT '',
  session_id    TEXT,
  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'waiting', 'rejected', 'failed', 'canceled')),
  summary       TEXT NOT NULL DEFAULT '',
  prompt        TEXT NOT NULL DEFAULT '',
  started_at    TEXT NOT NULL,
  finished_at   TEXT
);

INSERT INTO agent_runs_new
  (id, agent_id, trigger_kind, trigger, source_id, event_key, session_id, status, summary, prompt, started_at, finished_at)
  SELECT id, agent_id, trigger_kind, trigger, source_id, event_key, session_id, status, summary, '', started_at, finished_at
  FROM agent_runs;

DROP TABLE agent_runs;

ALTER TABLE agent_runs_new RENAME TO agent_runs;

-- 和 0036 一致的三条索引（唯一索引带 WHERE，别漏）
CREATE UNIQUE INDEX idx_agent_runs_event ON agent_runs(agent_id, event_key) WHERE event_key <> '';
CREATE INDEX idx_agent_runs_agent ON agent_runs(agent_id, started_at);
CREATE INDEX idx_agent_runs_status ON agent_runs(status, started_at);
