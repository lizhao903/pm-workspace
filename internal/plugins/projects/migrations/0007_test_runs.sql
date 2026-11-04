-- 0007_test_runs: 测试环境与测试报告（AUTO-08）
--
-- 一行是一次测试：在任务的工作区（projects_worktrees）上按项目档案的命令构建、起临时测试环境、等就绪、跑测试和冒烟，
-- 跑完回收环境、写 Markdown 报告。不挂外键：任务、工作区删了记录还留着当历史。
--
-- status：running（在跑）、passed（全部通过）、failed（有一步没过）、stopped（手动停了）、interrupted（工作台重启或插件停用，没跑完）。
-- steps 是 JSON 数组，每步 {key, label, command, dir, status, exit_code, duration_ms, timed_out, output, error, started_at, finished_at}。
-- pgid 是当前在跑那一步的进程组，env_pgid 是测试环境的进程组；结束时清 0。重启后按它们杀掉上次留下的进程组。
-- run_dir 是数据目录下 test-reports/<项目>/<任务编号>/<id>，报告 report.md 和约定的报告目录 out/ 都在里面。
-- artifact_ids 是登记为任务产出的报告和截图（JSON 数组）。
-- shots 是从 out/ 里收到的截图（相对 out/ 的路径，JSON 数组）；junit 是 out/ 里 junit xml 的用例汇总（JSON），没有为空串。
-- sop_* 是 SOP 节点发起时的执行、步骤、第几次尝试和输入；sop_notified 为 1 表示已经唤醒过挂起的步骤。

CREATE TABLE projects_test_runs (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  task_ref     TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  worktree_id  TEXT NOT NULL,
  workdir      TEXT NOT NULL,
  port         INTEGER NOT NULL,
  port_start   INTEGER NOT NULL,
  port_end     INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'running',
  steps        TEXT NOT NULL DEFAULT '[]',
  failed_step  TEXT NOT NULL DEFAULT '',
  error        TEXT NOT NULL DEFAULT '',
  url          TEXT NOT NULL DEFAULT '',
  run_dir      TEXT NOT NULL DEFAULT '',
  report_path  TEXT NOT NULL DEFAULT '',
  artifact_ids TEXT NOT NULL DEFAULT '[]',
  shots        TEXT NOT NULL DEFAULT '[]',
  junit        TEXT NOT NULL DEFAULT '',
  pgid         INTEGER NOT NULL DEFAULT 0,
  env_pgid     INTEGER NOT NULL DEFAULT 0,
  source       TEXT NOT NULL DEFAULT 'api',
  sop_run_id   TEXT NOT NULL DEFAULT '',
  sop_step     TEXT NOT NULL DEFAULT '',
  sop_attempt  INTEGER NOT NULL DEFAULT 0,
  sop_input    TEXT NOT NULL DEFAULT '{}',
  sop_notified INTEGER NOT NULL DEFAULT 0,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  updated_at   TEXT NOT NULL
);

CREATE INDEX projects_test_runs_task ON projects_test_runs(task_id, started_at);
CREATE UNIQUE INDEX projects_test_runs_running_task ON projects_test_runs(task_id) WHERE status = 'running';
CREATE INDEX projects_test_runs_sop ON projects_test_runs(sop_run_id, sop_step, sop_attempt) WHERE sop_run_id <> '';
