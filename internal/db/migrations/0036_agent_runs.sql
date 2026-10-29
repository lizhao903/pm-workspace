-- 0036_agent_runs: Agent 执行记录（AG-01b4）
--
-- 一行是 Agent 被任务、IM 消息、定时任务触发后的一次执行，对应原型 web-next/src/agentdata.ts 的 AgentRun，id 前缀 ar。
-- trigger_kind 为 task / im / schedule；trigger 是给人看的触发说明（如「任务分配给它 · TSK-0012」）。
-- source_id 是触发来源：任务的对象 id、IM 消息 id、定时任务 id。
-- event_key 是去重键：同一事件对同一 Agent 只触发一次，(agent_id, event_key) 唯一；手动之类不去重的为空串。
-- session_id 是这次执行建的会话；不建外键，会话删了执行记录保留。agent_id 同样不建外键，Agent 删了记录保留。
-- status 为 running / done / waiting / rejected / failed：running 是执行中（原型没有，后端异步执行要有），
-- 其余同原型。需确认的调用记在 agent_tool_calls.run_id（0035）。
-- summary 是 Agent 的总结或失败原因。时间列用定长毫秒 UTC（2006-01-02T15:04:05.000Z），finished_at 执行中为 NULL。

CREATE TABLE agent_runs (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  trigger_kind  TEXT NOT NULL CHECK (trigger_kind IN ('task', 'im', 'schedule')),
  trigger       TEXT NOT NULL DEFAULT '',
  source_id     TEXT NOT NULL DEFAULT '',
  event_key     TEXT NOT NULL DEFAULT '',
  session_id    TEXT,
  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'waiting', 'rejected', 'failed')),
  summary       TEXT NOT NULL DEFAULT '',
  started_at    TEXT NOT NULL,
  finished_at   TEXT
);

CREATE UNIQUE INDEX idx_agent_runs_event ON agent_runs(agent_id, event_key) WHERE event_key <> '';
CREATE INDEX idx_agent_runs_agent ON agent_runs(agent_id, started_at);
CREATE INDEX idx_agent_runs_status ON agent_runs(status, started_at);
CREATE INDEX idx_agent_tool_calls_run ON agent_tool_calls(run_id);
