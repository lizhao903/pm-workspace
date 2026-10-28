-- 0003_materials: 项目资料（PJ-03a）
--
-- 原型 web-next/src/projectdata.ts 的支持材料 Material 和项目文档 ProjectDoc 合成一张表：
-- 有 category（PRD、技术方案……）的就是原来的项目文档，没有的就是普通材料。
-- 列名照 docs/file-artifact-model.md 的 files 取，以后并进内核 files 是一条 INSERT SELECT：
--   category 对应 files.kind，props.tags 对应 files.props，source 对应 files.source。
-- 先放插件不放内核：内核迁移只加不改，现在只有项目资料一个用户，IM 附件、知识库的需要还没定。
--
-- 定位三选一，资料种类由哪一列非空推出来，不单独存（同 files 和 0012 的做法）：
--   path 非空且 mime='inode/directory' 是文件夹，path 非空是文件，url 是链接，note 是笔记。
-- path 存本机绝对路径，只存路径和元信息，不读文件内容。
-- 硬删项目时资料一起删，同干系人、会话绑定；软删项目不动，恢复后资料还在。

CREATE TABLE projects_materials (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  path       TEXT NOT NULL DEFAULT '',
  url        TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  mime       TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT '' CHECK (status IN ('', 'draft', 'review', 'final')),
  props      TEXT NOT NULL DEFAULT '{}',
  source     TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((path <> '') + (url <> '') + (note <> '') = 1),
  CHECK (mime = '' OR path <> '')
);

CREATE INDEX projects_materials_by_project ON projects_materials(project_id, created_at);
