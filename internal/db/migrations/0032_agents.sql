-- 0032_agents: Agent 配置（AG-01b1），会话挂到 Agent
--
-- 一行是一个 Agent，对应原型 web-next/src/agentdata.ts 的 Agent，id 前缀 ag。
-- 原型的 desc 是 SQL 关键字，列名用 description，接口里仍叫 desc。
-- 模型带服务商：provider_id + model。provider_id 保存时必须存在（代码查），不建外键：
-- 服务商删了 Agent 还在，前端标红让人换（同 agent_sessions.provider_id）。model 不校验是否在模型列表里。
-- avatar 是 JSON {kind, value}，kind 为 text / icon / image，image 的 value 是 data URL（图片 1MB 以内，代码查）。
-- skills、mcps、kbs 是 id 的 JSON 数组；技能、知识库的表在 AG-01b2、AG-01b3，这里不建外键。
-- triggers 是 JSON 数组 [{kind, detail}]，至少一条；kind 为 manual / im / schedule / task。
-- 工具权限 abilities 归 AG-02a，不在这张表。
-- 时间列用定长毫秒 UTC（2006-01-02T15:04:05.000Z）。

CREATE TABLE agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  color         TEXT NOT NULL DEFAULT '',
  avatar        TEXT NOT NULL DEFAULT '{"kind":"text","value":""}',
  provider_id   TEXT NOT NULL,
  model         TEXT NOT NULL,
  instructions  TEXT NOT NULL DEFAULT '',
  skills        TEXT NOT NULL DEFAULT '[]',
  mcps          TEXT NOT NULL DEFAULT '[]',
  kbs           TEXT NOT NULL DEFAULT '[]',
  triggers      TEXT NOT NULL DEFAULT '[{"kind":"manual","detail":""}]',
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 会话属于哪个 Agent，NULL 是不挂 Agent 的老会话。不建外键：Agent 删了会话保留，
-- 接口按 agent_id 查不到 Agent 时回 agent_deleted: true。
ALTER TABLE agent_sessions ADD COLUMN agent_id TEXT;

CREATE INDEX idx_agent_sessions_agent ON agent_sessions(agent_id);
