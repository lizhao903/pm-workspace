-- 0003_shortcuts: 快捷访问区（分组 + 条目）
-- 不带种子数据：首次进入走空态引导，让用户自己添第一条。

PRAGMA foreign_keys = ON;

-- 快捷访问的分组。折叠状态也落库，刷新后保持
CREATE TABLE shortcut_groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '',
  collapsed  INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 快捷入口条目。group_id 可空表示未分组；删组时置 NULL 而不是级联删条目
CREATE TABLE shortcuts (
  id           TEXT PRIMARY KEY,
  group_id     TEXT REFERENCES shortcut_groups(id) ON DELETE SET NULL,
  label        TEXT NOT NULL,
  target_kind  TEXT NOT NULL DEFAULT 'url',     -- url | internal | command
  url          TEXT NOT NULL DEFAULT '',        -- target_kind=url，支持 {{变量}}
  nav          TEXT NOT NULL DEFAULT '{}',      -- target_kind=internal，JSON NavSelection
  command      TEXT NOT NULL DEFAULT '',        -- target_kind=command
  icon         TEXT NOT NULL DEFAULT '',        -- 1-2 个字符的文字标，或预置图形名
  color        TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  open_in      TEXT NOT NULL DEFAULT 'new_tab', -- new_tab | same_tab
  pinned       INTEGER NOT NULL DEFAULT 0,      -- 置顶到顶栏图标条
  sort_order   INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  use_count    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_shortcuts_group ON shortcuts(group_id, sort_order);
CREATE INDEX idx_shortcuts_pinned ON shortcuts(pinned, sort_order);
