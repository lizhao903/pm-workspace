-- 0009_releases: 发布记录（AUTO-10）
--
-- 一行是一次发布：在任务的工作区（projects_worktrees）上按项目档案的命令分两段跑。
--   准备（phase = prepare）：版本号与更新日志（version）→ 打包（package），只在工作区里跑，不碰生产；跑完停在 prepared 等上线审批。
--   上线（phase = deploy）：审批通过后才跑，发布前检查（preflight，备份与密钥核对）→ 发布（release）→ 线上冒烟（prod_smoke）；
--   发布或线上冒烟没过时自动回滚（rollback）。
-- 不挂外键：任务、工作区删了记录还留着当历史。
--
-- status：running（在跑，看 phase 是哪一段）、prepared（准备好了，等审批）、released（上线成功）、
-- failed（没过：准备段没过，或发布前检查没过，生产没动；或发布、冒烟没过又没配回滚命令）、
-- rolled_back（发布或线上冒烟没过，已自动回滚）、rollback_failed（回滚也没成）、
-- stopped（手动停了）、interrupted（工作台重启或插件停用，没跑完）、cancelled（等审批时又准备了一次，这次作废）。
-- steps 是 JSON 数组，每步 {key, label, phase, command, dir, timeout_sec, status, exit_code, duration_ms, timed_out, output, error, started_at, finished_at}；
-- 两段的命令在准备时一起定下（审批看到的就是要跑的），回滚那步只在需要时跑，不需要记 skipped。
-- rollback_state：''（不需要回滚）、done（回滚成功）、failed（回滚没成）、unavailable（要回滚但档案里没有回滚命令）。
-- version、changelog 是版本号和更新日志：version 那步写进 $RELEASE_DIR/version.txt、changelog.md，没写 version.txt 时取输出最后一行。
-- pgid 是当前在跑那一步的进程组，结束时清 0；重启后按它杀掉上次留下的进程组。
-- run_dir 是数据目录下 releases/<项目>/<任务编号>/<id>，报告 report.md 和约定目录 out/（环境变量 RELEASE_DIR）都在里面。
-- approved_at、approved_by 是上线审批的时间和来源（sop:<执行 id> 或 api）。
-- sop_* 是当前等结果的 SOP 步骤（准备段、上线段各自一次），prep_key、deploy_key 是发起这两段的 SOP 写入键（<执行>/<步骤>#<尝试>），重跑同一次尝试不重复起。

CREATE TABLE projects_releases (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  task_ref       TEXT NOT NULL,
  project_id     TEXT NOT NULL,
  worktree_id    TEXT NOT NULL,
  workdir        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'running',
  phase          TEXT NOT NULL DEFAULT 'prepare',
  version        TEXT NOT NULL DEFAULT '',
  changelog      TEXT NOT NULL DEFAULT '',
  steps          TEXT NOT NULL DEFAULT '[]',
  failed_step    TEXT NOT NULL DEFAULT '',
  error          TEXT NOT NULL DEFAULT '',
  rollback_state TEXT NOT NULL DEFAULT '',
  run_dir        TEXT NOT NULL DEFAULT '',
  report_path    TEXT NOT NULL DEFAULT '',
  artifact_ids   TEXT NOT NULL DEFAULT '[]',
  pgid           INTEGER NOT NULL DEFAULT 0,
  source         TEXT NOT NULL DEFAULT 'api',
  approved_at    TEXT,
  approved_by    TEXT NOT NULL DEFAULT '',
  sop_run_id     TEXT NOT NULL DEFAULT '',
  sop_step       TEXT NOT NULL DEFAULT '',
  sop_attempt    INTEGER NOT NULL DEFAULT 0,
  sop_input      TEXT NOT NULL DEFAULT '{}',
  sop_notified   INTEGER NOT NULL DEFAULT 0,
  prep_key       TEXT NOT NULL DEFAULT '',
  deploy_key     TEXT NOT NULL DEFAULT '',
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  updated_at     TEXT NOT NULL
);

CREATE INDEX projects_releases_task ON projects_releases(task_id, started_at);
CREATE UNIQUE INDEX projects_releases_running_task ON projects_releases(task_id) WHERE status = 'running';
CREATE INDEX projects_releases_project ON projects_releases(project_id, status);
CREATE INDEX projects_releases_prep ON projects_releases(prep_key) WHERE prep_key <> '';
CREATE INDEX projects_releases_deploy ON projects_releases(deploy_key) WHERE deploy_key <> '';
