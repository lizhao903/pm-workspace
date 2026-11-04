-- 0050_task_run_harness_session: dsh 这次跑在哪段会话上
--
-- 只有 harness = 'deepseek' 的执行会填：dsh 用 session-<uuid> 标识一段会话，
-- 带上它再跑一次就是在同一段对话里继续（`--session-id`）。claude 没有这个概念，留空串。
-- 续跑是可选行为：界面上勾了「接着上次会话」才会把它传给下一次执行。

ALTER TABLE task_runs ADD COLUMN harness_session TEXT NOT NULL DEFAULT '';
