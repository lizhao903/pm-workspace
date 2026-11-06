-- 0053_agent_session_model: 会话里切换 Agent 用的模型（TSK-0720）
--
-- 挂了 Agent 的会话原来一律按 Agent 当前的服务商和模型跑，provider_id / model 只是每轮写回的快照。
-- 现在会话可以单独换模型：model_override = 1 时 provider_id / model 是这个会话自己选的，
-- 按它跑、不再跟 Agent 走；为 0 时跟随 Agent 当前的默认（Agent 改了默认，这些会话跟着变），
-- 两列只是快照，Agent 删了以后读出来的就是它。不挂 Agent 的会话 provider_id / model 一直是自己的，这列恒为 0。
--
-- 每条助手回复记下当时用的服务商和模型（provider_id / model），会话中途换了模型也看得出哪条是谁答的；
-- 之前的消息为空串，界面不显示。不加外键：服务商删了消息照样留着。

ALTER TABLE agent_sessions ADD COLUMN model_override INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_messages ADD COLUMN provider_id TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_messages ADD COLUMN model TEXT NOT NULL DEFAULT '';
