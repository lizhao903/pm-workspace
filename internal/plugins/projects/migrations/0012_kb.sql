-- 0012_kb: 项目知识库（TSK-0721）
--
-- projects_kb 一行是一个项目绑定的知识库（内核 knowledge_bases 的 id），一个项目最多一个；不挂知识库的外键：
-- 知识库在知识库页被删了这一行照留，界面显示「绑定的知识库已删除」，下次同步按「没有知识库」新建并换绑。
-- auto_created 是同步节点替项目建的（1）还是人在项目设置里选、建的（0）。
-- last_sync_at、last_result 是最近一次同步（节点或项目设置里「立即同步」）的时间和结果 JSON
-- （{added, updated, removed, unchanged, skipped, failed, failures, skips, error}），给项目设置显示；没同步过为 NULL、'{}'。
-- 知识库里哪些篇是这个项目同步进来的记在内核 kb_docs.origin（projects:<项目 id>，内核迁移 0054），这里不另记。
-- 硬删项目时一起删；软删不动。
--
-- projects_sop_templates 是已经写进 SOP 的内置流程（「每周一 10:00 整理项目知识库」），写过一次就不再写，用户删了不补回来；
-- 卸载时撤下没改过的再删这一行（同 video_sop_templates）。

CREATE TABLE projects_kb (
  project_id   TEXT PRIMARY KEY REFERENCES objects(id) ON DELETE CASCADE,
  kb_id        TEXT NOT NULL,
  auto_created INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  last_result  TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE projects_sop_templates (
  flow_id      TEXT PRIMARY KEY,
  installed_at TEXT NOT NULL
);
