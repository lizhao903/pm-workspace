-- 0001_init: 工作对象骨架（类型 + 分类树 + 对象 + 标签 + 关联 + 修订）

PRAGMA foreign_keys = ON;

-- 工作对象类型：需求 / 待办 / 项目 / 文档 / 资源 / 笔记，可自定义扩展
CREATE TABLE object_types (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  plural      TEXT NOT NULL,
  ref_prefix  TEXT NOT NULL,
  icon        TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '#6c6c78',
  builtin     INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  statuses    TEXT NOT NULL DEFAULT '[]',   -- JSON [{key,label,color,terminal}]
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 分类树：归属维度，单选，按类型隔离，物化路径便于子树查询
CREATE TABLE categories (
  id          TEXT PRIMARY KEY,
  type_id     TEXT NOT NULL REFERENCES object_types(id) ON DELETE CASCADE,
  parent_id   TEXT REFERENCES categories(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  path        TEXT NOT NULL,                -- '/root-slug/child-slug/'
  depth       INTEGER NOT NULL DEFAULT 0,
  color       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_categories_slug ON categories(type_id, IFNULL(parent_id,''), slug);
CREATE INDEX idx_categories_type ON categories(type_id, sort_order);
CREATE INDEX idx_categories_path ON categories(type_id, path);

-- 工作对象主表（单表多态）
CREATE TABLE objects (
  id           TEXT PRIMARY KEY,
  type_id      TEXT NOT NULL REFERENCES object_types(id),
  ref          TEXT NOT NULL UNIQUE,        -- REQ-0142
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT '',
  priority     TEXT NOT NULL DEFAULT '',    -- P0..P3 / ''
  owner        TEXT NOT NULL DEFAULT '',
  category_id  TEXT REFERENCES categories(id) ON DELETE SET NULL,
  project_id   TEXT REFERENCES objects(id) ON DELETE SET NULL,
  source       TEXT NOT NULL DEFAULT '',    -- inbox/slack/import/manual
  props        TEXT NOT NULL DEFAULT '{}',  -- JSON 自定义字段
  due_at       TEXT,
  started_at   TEXT,
  completed_at TEXT,
  archived_at  TEXT,
  deleted_at   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_objects_type     ON objects(type_id, deleted_at, updated_at DESC);
CREATE INDEX idx_objects_category ON objects(category_id, deleted_at);
CREATE INDEX idx_objects_status   ON objects(type_id, status, deleted_at);
CREATE INDEX idx_objects_due      ON objects(due_at) WHERE due_at IS NOT NULL;
CREATE INDEX idx_objects_project  ON objects(project_id);

-- 人类可读编号计数器
CREATE TABLE ref_counters (
  type_id  TEXT PRIMARY KEY REFERENCES object_types(id) ON DELETE CASCADE,
  next_seq INTEGER NOT NULL DEFAULT 1
);

-- 标签：交叉维度，多选，跨类型共享
CREATE TABLE tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE object_tags (
  object_id TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  tag_id    TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (object_id, tag_id)
);
CREATE INDEX idx_object_tags_tag ON object_tags(tag_id);

-- 万物关联
CREATE TABLE links (
  id         TEXT PRIMARY KEY,
  from_id    TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  to_id      TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  relation   TEXT NOT NULL,   -- relates/blocks/duplicates/parent/child/references
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_links_uniq ON links(from_id, to_id, relation);
CREATE INDEX idx_links_to ON links(to_id);

-- 字段级修订历史：日报周报与回滚的数据源
CREATE TABLE revisions (
  id         TEXT PRIMARY KEY,
  object_id  TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  field      TEXT NOT NULL,
  old_value  TEXT NOT NULL DEFAULT '',
  new_value  TEXT NOT NULL DEFAULT '',
  actor      TEXT NOT NULL DEFAULT 'me',
  source     TEXT NOT NULL DEFAULT 'ui',   -- ui/api/agent/import
  created_at TEXT NOT NULL
);
CREATE INDEX idx_revisions_object ON revisions(object_id, created_at DESC);
CREATE INDEX idx_revisions_time   ON revisions(created_at DESC);
