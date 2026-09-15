-- 0005_dictionaries: 通用字典表（可配置枚举）
--
-- 优先级原本写死在前端、关联关系原本写死在后端常量里，用户加一个 P4 或一种新关系
-- 就得改代码。这里收成一张通用字典表：后面 RAID 的概率/影响分级、ADR 状态、
-- 发布里程碑类型都往这里加 dict_id，不必再各建一张专用表。
--
-- 现有数据零迁移：objects.priority 和 links.relation 存的就是 key，
-- 字典只是给这些裸值补上 label 和颜色。

PRAGMA foreign_keys = ON;

-- 一个字典就是一组枚举值。builtin 的字典不可删（条目仍可增删改）
CREATE TABLE dictionaries (
  id          TEXT PRIMARY KEY,                -- 'priority' | 'link_relation' | ...
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  scope       TEXT NOT NULL DEFAULT 'global',  -- global | type（按工作对象类型隔离）
  builtin     INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 条目只有 archived_at（停用），没有软删列：枚举值一旦被业务数据引用，
-- 删掉就会在列表里留下没标签没颜色的裸值，而且查不出它从哪来。
-- 真要删得先确认引用数为 0，那才走 DELETE。
CREATE TABLE dict_items (
  id          TEXT PRIMARY KEY,
  dict_id     TEXT NOT NULL REFERENCES dictionaries(id) ON DELETE CASCADE,
  type_id     TEXT REFERENCES object_types(id) ON DELETE CASCADE, -- scope='type' 时用
  key         TEXT NOT NULL,                   -- 落在业务表里的值，如 'P0'，一经创建不可改
  label       TEXT NOT NULL,                   -- 显示名，如 '最高'
  color       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  meta        TEXT NOT NULL DEFAULT '{}',      -- JSON，放各字典特有的属性
  archived_at TEXT,                            -- 停用，不是删除
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- IFNULL(type_id,'') 让 global 字典（type_id 为 NULL）也能参与唯一约束：
-- SQLite 的唯一索引把多个 NULL 视为互不相同，直接用 type_id 会放过重复的 key。
CREATE UNIQUE INDEX idx_dict_items_key ON dict_items(dict_id, IFNULL(type_id,''), key);
CREATE INDEX idx_dict_items_dict ON dict_items(dict_id, sort_order);

-- --- 内置字典的种子 ---
-- 写在迁移里而不是 SeedDemo：这两个是系统必需的基础数据，
-- 不带 --seed-demo 启动的空库也必须有它们，否则优先级下拉是空的。

INSERT INTO dictionaries (id,name,description,scope,builtin,sort_order,created_at,updated_at) VALUES
 ('priority','优先级','工作对象的优先级，落在 objects.priority','global',1,10,datetime('now'),datetime('now')),
 ('link_relation','关联关系','对象之间的关联类型，落在 links.relation','global',1,20,datetime('now'),datetime('now'));

INSERT INTO dict_items (id,dict_id,type_id,key,label,color,description,sort_order,meta,archived_at,created_at,updated_at) VALUES
 ('dit_prio_p0','priority',NULL,'P0','最高','#c92a2a','',10,'{}',NULL,datetime('now'),datetime('now')),
 ('dit_prio_p1','priority',NULL,'P1','高','#e8590c','',20,'{}',NULL,datetime('now'),datetime('now')),
 ('dit_prio_p2','priority',NULL,'P2','中','#f08c00','',30,'{}',NULL,datetime('now'),datetime('now')),
 ('dit_prio_p3','priority',NULL,'P3','低','#868e96','',40,'{}',NULL,datetime('now'),datetime('now'));

-- meta.inverse 是反向关系的显示名：链接表只存一个方向，
-- 详情页要在对端对象上显示「被阻塞于」就得靠它。
INSERT INTO dict_items (id,dict_id,type_id,key,label,color,description,sort_order,meta,archived_at,created_at,updated_at) VALUES
 ('dit_rel_relates','link_relation',NULL,'relates','相关','#868e96','',10,'{"inverse":"相关"}',NULL,datetime('now'),datetime('now')),
 ('dit_rel_blocks','link_relation',NULL,'blocks','阻塞','#c92a2a','',20,'{"inverse":"被阻塞于"}',NULL,datetime('now'),datetime('now')),
 ('dit_rel_duplicates','link_relation',NULL,'duplicates','重复','#f08c00','',30,'{"inverse":"被重复"}',NULL,datetime('now'),datetime('now')),
 ('dit_rel_parent','link_relation',NULL,'parent','父级','#3b5bdb','',40,'{"inverse":"子级"}',NULL,datetime('now'),datetime('now')),
 ('dit_rel_references','link_relation',NULL,'references','引用','#0c8599','',50,'{"inverse":"被引用"}',NULL,datetime('now'),datetime('now'));
