-- 0008_test_env_keep: 测试环境保留给人工验收（AUTO-09）
--
-- 测试通过后可以不回收测试环境，进程接着跑，留给人工验收访问；到点、验收结束、任务完成、工作区清理、再跑一次测试时回收。
-- env_state：''（没保留：跑完即回收，或没有测试环境）、kept（保留中）、released（保留过、已回收）。
-- env_keep_until 是到点回收的时间（RFC3339 UTC），没保留为 NULL；env_released_at 是保留后回收的时间。
-- env_release_reason：expired（到点）、accepted（验收通过）、stage_changed（阶段离开待验收）、task_done（任务完成或取消）、
-- worktree_removed（工作区清理）、rerun（同一任务又跑了一次测试）、manual（手动回收）、exited（环境自己退出了）、
-- restart（工作台重启过）、plugin_stopped（项目插件停用）。
-- 保留期间测试环境的进程组号仍在 env_pgid，回收后清 0。
--
-- projects_worktree_settings.env_keep_hours 是默认保留时长（小时，1 到 168，默认 24）。

ALTER TABLE projects_test_runs ADD COLUMN env_state TEXT NOT NULL DEFAULT '';
ALTER TABLE projects_test_runs ADD COLUMN env_keep_until TEXT;
ALTER TABLE projects_test_runs ADD COLUMN env_released_at TEXT;
ALTER TABLE projects_test_runs ADD COLUMN env_release_reason TEXT NOT NULL DEFAULT '';

CREATE INDEX projects_test_runs_kept ON projects_test_runs(task_id) WHERE env_state = 'kept';

ALTER TABLE projects_worktree_settings ADD COLUMN env_keep_hours INTEGER NOT NULL DEFAULT 24;
