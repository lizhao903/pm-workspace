-- demo 插件的第一条迁移：插件内单独编号，和内核的 0001 无关
CREATE TABLE demo_items (
  id          TEXT PRIMARY KEY,
  object_id   TEXT REFERENCES objects(id),
  title       TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX demo_items_object ON demo_items(object_id);
