-- 0047_agent_session_source: 会话的来源（从哪条记录发起的会话）
--
-- source_ref 是 JSON 对象原文，空串表示不是从别的记录发起的（0047 之前的会话都是）。
-- 由发起方在 POST /api/agent/sessions 时给，之后不改。现在只有 IM 消息插件用：
-- 从一条消息（或合并显示的一组消息）发起会话时，记 {kind:"im_message", message_id, message_ids, ...}，
-- 形状同「转任务」写进任务 props.source_ref 的那份（IM 插件 toTask）。
-- 会话里 Agent 用 create_object 新建的对象，props.source_ref 缺省记这一份；
-- 里面有 project_id 时对象缺省挂到这个项目（项目已删就不挂）。

ALTER TABLE agent_sessions ADD COLUMN source_ref TEXT NOT NULL DEFAULT '';
