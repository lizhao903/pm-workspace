-- 0045_agent_thinking: Agent 的思考档位，和「场景默认 Agent」的设置
--
-- agents.thinking 是这个 Agent 调模型时要不要思考、想多深：
--   default 请求里不带任何思考参数，交给模型自己的默认（老行为，存量 Agent 都是它）
--   off / low / medium / high 按各家的写法翻成请求参数，见 internal/agent/thinking.go。
-- 模型不认这些参数时调用方自动去掉重来一次，不会因此失败。
--
-- agent_settings 是 Agent 这一块的小设置，一行一个 key，value 是 JSON。
-- 现在只有 scenario:<场景> 一类：值是 Agent id 的 JSON 字符串，空串表示没选，
-- 场景有 sop_assist（SOP 编排助手）、background（其他后台调用），见 internal/agent/scenario.go。
-- 不建外键：Agent 删了设置还在，用的时候查不到就退回默认服务商、思考 default，界面标红让人换。

ALTER TABLE agents ADD COLUMN thinking TEXT NOT NULL DEFAULT 'default';

CREATE TABLE agent_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '""',
  updated_at  TEXT NOT NULL
);
