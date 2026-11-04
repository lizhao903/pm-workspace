-- 0049_task_run_harness: 执行记录的执行器（这次是谁跑的）
--
-- claude：本机 claude CLI，0009 以来的执行都是这种。
-- deepseek：deepseek-harness（dsh）的 headless 一次性任务模式，模型按那次执行
--   解析出来的服务商路由走 dsh 的配置。
-- 只用于留档与展示，不参与收尾判定：收尾看状态和退出码。

ALTER TABLE task_runs ADD COLUMN harness TEXT NOT NULL DEFAULT 'claude';
