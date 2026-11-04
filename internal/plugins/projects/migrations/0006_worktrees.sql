-- 0006_worktrees: 需求级 git worktree（AUTO-07）
--
-- 每个进研发的任务在项目代码库建一个独立 worktree 和分支 auto/<任务 ref>，worktree 放在数据目录下的 worktrees/<项目 id>/<任务 ref>，
-- 不放进代码库。一行是一次准备：清理后 status 改 removed、留着当历史，端口段随之归还；同一任务只能有一行 active。
-- 不挂外键：任务、项目硬删后记录还要拿来清目录。
--
-- repo_dir 是代码库所在 git 仓库的根目录，sub_dir 是档案里的代码库目录相对仓库根的路径（通常为空），
-- root 是 worktree 目录，执行用的目录是 root/sub_dir。base_commit 是建分支时主目录 HEAD 的提交。
-- port_start、port_count 是分给这个工作区的端口段（测试环境用，AUTO-08），只在 active 的行之间不重叠。
-- last_error 是最近一次自动清理失败的原因（有未提交的改动等），清理成功或重新准备时清掉。
-- removed_reason：task_done、task_cancelled、released、manual；branch_deleted 为 1 表示清理时分支已合并、一起删了。

CREATE TABLE projects_worktrees (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  task_ref       TEXT NOT NULL,
  project_id     TEXT NOT NULL,
  repo_dir       TEXT NOT NULL,
  sub_dir        TEXT NOT NULL DEFAULT '',
  root           TEXT NOT NULL,
  branch         TEXT NOT NULL,
  base_commit    TEXT NOT NULL DEFAULT '',
  port_start     INTEGER NOT NULL,
  port_count     INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',
  last_error     TEXT NOT NULL DEFAULT '',
  removed_reason TEXT NOT NULL DEFAULT '',
  branch_deleted INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  removed_at     TEXT
);

CREATE UNIQUE INDEX projects_worktrees_active_task ON projects_worktrees(task_id) WHERE status = 'active';
CREATE INDEX projects_worktrees_project ON projects_worktrees(project_id, created_at);

-- 工作区端口范围：单行。默认 7900 到 8899、每段 10 个，避开工作台自己用的 7700 到 7899。
CREATE TABLE projects_worktree_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  port_min   INTEGER NOT NULL,
  port_max   INTEGER NOT NULL,
  port_block INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
