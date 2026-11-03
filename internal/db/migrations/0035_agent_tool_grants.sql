-- 0035_agent_tool_grants: Agent 工具授权和需要确认的调用（AG-02a）
--
-- agent_tool_grants 一行是一个 Agent 对一个工具的授权，对应原型 web-next/src/agentdata.ts 的 Agent.abilities。
-- key 是内置能力（原型 ABILITIES 的 key，如 read_tasks）或连接器工具 conn:<连接器 id>:<工具名>。
-- mode 为 confirm / auto；关闭不存行，没有行就是关闭。实际档位 = min(这里, 连接器上的授权)，代码算。
-- 不建外键：删 Agent、删连接器时由代码清掉对应的行。
--
-- agent_tool_calls 一行是一次要人确认的调用（会话里或执行记录里），id 前缀 atc。
-- session_id、run_id 二选一，执行记录归 AG-01b4，现在只有会话。call_id 是模型给的调用 id。
-- grant_key 是这次调用对应的授权 key；args 是模型给的参数 JSON 原文。
-- state 为 pending / confirmed / rejected，只能从 pending 改一次；result 是执行结果（给人看的一句话）。
-- 时间列用定长毫秒 UTC（2006-01-02T15:04:05.000Z）。

CREATE TABLE agent_tool_grants (
  agent_id    TEXT NOT NULL,
  key         TEXT NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('confirm', 'auto')),
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (agent_id, key)
);

CREATE TABLE agent_tool_calls (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  session_id  TEXT,
  run_id      TEXT,
  call_id     TEXT NOT NULL DEFAULT '',
  tool        TEXT NOT NULL,
  grant_key   TEXT NOT NULL,
  args        TEXT NOT NULL DEFAULT '{}',
  state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'confirmed', 'rejected')),
  result      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  decided_at  TEXT
);

CREATE INDEX idx_agent_tool_calls_session ON agent_tool_calls(session_id);
CREATE INDEX idx_agent_tool_calls_agent ON agent_tool_calls(agent_id, state);

-- 已有的 Agent 按原型 newAgent 的默认值补上：只开查任务、查联系人
INSERT INTO agent_tool_grants (agent_id, key, mode, updated_at)
  SELECT id, 'read_tasks', 'auto', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM agents;
INSERT INTO agent_tool_grants (agent_id, key, mode, updated_at)
  SELECT id, 'read_contacts', 'auto', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM agents;
