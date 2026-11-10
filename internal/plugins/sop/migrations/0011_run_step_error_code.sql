-- 0011_run_step_error_code: 执行步骤失败带错误码（TSK-0498，插件 0.20.0）
--
-- 条件分支、条件回退的条件存成一句话时，这一步失败并记错误码 rule_text；
-- 前端据此不给「重试」（原执行沿用发起时的流程快照，重试必然原样失败），
-- 改给「去改流程」「按最新流程重新发起」「跳过这一步」。
-- 只增一列，已有执行的这一列为空串，行为不变。

ALTER TABLE sop_run_steps ADD COLUMN error_code TEXT NOT NULL DEFAULT '';
