-- 0048_task_run_mode: 执行记录的执行方式（交给 Claude Code 的两种方式）
--
-- stream：工作台起 claude 子进程、流式回推输出（0009 起的老执行都是这种）。
-- terminal：在工作台的终端里开交互式 claude 会话。进程不归工作台管，
--   开始时间是发起时；结束和结论由终端里的 claude 经 MCP（pmw_finish_run）回写，
--   用户也能在界面上手动「标记结束」。所以不能按「本进程手上没有」把它判成失败。

ALTER TABLE task_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'stream';
