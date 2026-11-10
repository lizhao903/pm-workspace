-- 0057_agent_session_instruction: 会话级追加要求（S-2 上下文治理最小版）
--
-- 用户在一条会话上写一句「这次会话的追加要求」，每一轮都拼进系统提示词的最后。
-- 和 Agent 的 instructions 分工：Agent 是长期人设与职责，会话 instruction 只对这一次对话生效，
-- 比如「这次只讨论前端，不要建任务」。
-- 空串表示没有追加要求（也是老会话和没传过的会话的默认值），不建索引：只按会话 id 读，没有按它筛的场景。

ALTER TABLE agent_sessions ADD COLUMN instruction TEXT NOT NULL DEFAULT '';
