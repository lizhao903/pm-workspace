-- 0010_proto_syncs: 原型回写旁路（AUTO-11，docs/auto-delivery-flow.md 第 2 节）
--
-- projects_proto_syncs 一行是一次原型同步：按上线代码（代码库生产分支）回写原型库和规格。
-- 同步点是最近一次 done / no_change / baseline 的 head_commit：下次只看 head_commit 到新 HEAD 的增量。
-- 同一项目同时只能有一次进行中（running / reviewing），部分唯一索引。不挂外键：项目删了记录还留着当历史。
--
-- trigger_kind（接口里叫 trigger，trigger 是 SQL 关键字）：release（发布成功）、merge（生产分支 HEAD 变了，定时检查）、daily（每日巡检）、manual（手动）、baseline（手动设基线，不跑流程）。
-- trigger_ref：release 是发布 id，merge 是检查到的 HEAD，daily 是日期，其余为空串。
-- status：running（在跑）、reviewing（有拿不准的差异等产品裁决）、done（已同步）、no_change（没有涉及界面或接口的改动，只前移同步点）、
-- baseline（设基线）、failed（没成功，同步点不动）、cancelled（手动作废）。
-- code_branch 是生产分支，base_commit → head_commit 是这次的代码范围（base 为空是首次同步，对比整个代码库）。
-- files 是改动的文件（JSON 数组，最多 500 个），diff_stat 是 git diff --stat 的尾部，ui_changed 是有没有涉及界面或接口的改动。
-- proto_dir 是原型库目录（档案的原型库目录，没设退到 PRD 目录、代码库目录），proto_repo 是它所在 git 仓库的根；
-- proto_branch 是原型库的同步分支（proto-sync/<日期>，同一天第二次起加 -2、-3），从 proto_base（原型库当前检出的提交）拉出，
-- proto_path 是同步分支的 worktree 里对应原型目录的路径（数据目录下 worktrees/<项目>/proto-sync-<id>），记完同步点后删掉 worktree、分支保留；
-- proto_commit 是同步分支上最后的提交，原型没改为空串。只提交到同步分支，不碰原型库的主分支，产品看过差异清单后自己合并。
-- items 是差异清单（JSON 数组），每项 {kind, title, detail, spec, page, status, decision}：
--   kind：added（代码有原型没有）、changed（都有但不一致）、unimplemented（原型有代码没有）、removed（代码已删原型还在）、uncertain（拿不准）；
--   status 是规格的实现状态：implemented、unimplemented、offline、deviation（判为缺陷，实现有偏差）、pending（等裁决或暂不处理）；
--   decision 只有 uncertain 有：''（待裁决）、design（当作新设计，按代码回写）、defect（当作缺陷，建修复任务）、ignore（暂不处理）。
-- decision、decided_at 是这次的人工裁决，fix_task_id 是判为缺陷时建的修复任务。
-- run_dir 是数据目录下 proto-syncs/<项目>/<id>，diff.patch 在里面。run_id 是项目插件发起 SOP 时拿到的运行 id，sop_run_id 是 SOP 执行 id。
-- sop_key 是在 SOP 里直接发起（没有 sync_id）时取同步范围那一步的写入键，重跑同一次尝试不重复建行。

CREATE TABLE projects_proto_syncs (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  trigger_kind  TEXT NOT NULL,
  trigger_ref   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'running',
  code_dir      TEXT NOT NULL DEFAULT '',
  code_branch   TEXT NOT NULL DEFAULT '',
  base_commit   TEXT NOT NULL DEFAULT '',
  head_commit   TEXT NOT NULL DEFAULT '',
  files         TEXT NOT NULL DEFAULT '[]',
  diff_stat     TEXT NOT NULL DEFAULT '',
  ui_changed    INTEGER NOT NULL DEFAULT 0,
  proto_dir     TEXT NOT NULL DEFAULT '',
  proto_repo    TEXT NOT NULL DEFAULT '',
  proto_branch  TEXT NOT NULL DEFAULT '',
  proto_base    TEXT NOT NULL DEFAULT '',
  proto_commit  TEXT NOT NULL DEFAULT '',
  proto_path    TEXT NOT NULL DEFAULT '',
  items         TEXT NOT NULL DEFAULT '[]',
  decision      TEXT NOT NULL DEFAULT '',
  decided_at    TEXT,
  fix_task_id   TEXT NOT NULL DEFAULT '',
  summary       TEXT NOT NULL DEFAULT '',
  run_dir       TEXT NOT NULL DEFAULT '',
  run_id        TEXT NOT NULL DEFAULT '',
  sop_run_id    TEXT NOT NULL DEFAULT '',
  sop_key       TEXT NOT NULL DEFAULT '',
  error         TEXT NOT NULL DEFAULT '',
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  updated_at    TEXT NOT NULL
);

CREATE INDEX projects_proto_syncs_project ON projects_proto_syncs(project_id, started_at);
CREATE UNIQUE INDEX projects_proto_syncs_active ON projects_proto_syncs(project_id) WHERE status IN ('running', 'reviewing');
CREATE INDEX projects_proto_syncs_sop_key ON projects_proto_syncs(sop_key) WHERE sop_key <> '';

-- projects_proto_sync_settings 一个项目一行：三种自动触发各自的开关，默认都关（停用）；没有行等于都关。
-- on_release：发布成功（发布记录 released）后发起；on_merge：定时检查生产分支 HEAD，和同步点不同就发起；
-- daily、daily_at：每天 daily_at（本机时间 HH:MM）后第一次检查时巡检一次，HEAD 没变只记一行 no_change。
-- branch 是生产分支，空串时依次认 main、master、代码库当前检出的分支。
CREATE TABLE projects_proto_sync_settings (
  project_id  TEXT PRIMARY KEY,
  on_release  INTEGER NOT NULL DEFAULT 0,
  on_merge    INTEGER NOT NULL DEFAULT 0,
  daily       INTEGER NOT NULL DEFAULT 0,
  daily_at    TEXT NOT NULL DEFAULT '09:00',
  branch      TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL
);
