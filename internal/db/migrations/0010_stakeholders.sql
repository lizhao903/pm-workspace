-- 0010_stakeholders: 干系人名册，以及把 objects.owner 的自由文本迁成引用
--
-- 原来 owner 是一个自由文本字段，谁想怎么填就怎么填。代价在真实数据里已经出现了：
-- 库里 11 条有负责人的记录中，有一条是「宋一杰、李钊、振华」——三个人挤在一个字段。
-- 这种值没法筛选（按 owner='李钊' 查不到它）、没法统计、改个名字要全表替换。
--
-- 拆成「一个负责人 + 若干参与人」而不是「负责人可多选」：
-- 一件事必须有唯一一个人对结果负责，否则「这事该找谁」就没有答案。
-- 参与人表达的是「还有谁在这件事里」，信息不丢，但不承担「找谁」的语义。
--
-- **objects.owner 这一列保留，不删。**
--   1. 迁移是单向的，而这个项目到今天才刚建立版本控制、数据本身仍无自动备份。
--      留着原文本，万一下面的拆分逻辑对某条数据判断错了，原始值还在，可以对着改。
--   2. 它同时是展示兜底：owner_id 为空但 owner 文本非空时，界面仍能显示出个人名来，
--      不会因为迁移漏了某条就变成一片空白。
--   新写入一律只写 owner_id / object_participants，owner 列从此只读。

PRAGMA foreign_keys = ON;

-- 干系人名册。没有软删列，只有 archived_at——和 dict_items 同一个道理：
-- 人一旦被历史对象引用过，删掉就会在列表里留下一个查不出来源的空位。
-- 离职的人归档即可，历史记录仍然显示得出他当时负责过什么。
CREATE TABLE stakeholders (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT '',   -- 产品 / 研发 / 测试 / 业务方……自由填
  email       TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '',   -- 头像底色，空则由前端按名字哈希
  sort_order  INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,                       -- NULL = 在岗
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 同名不许重复：干系人靠名字辨认，出现两个「李钊」时用户无从选择，
-- 而错选的后果是任务分配到了另一个人身上。要区分同名的人请在 role/note 里写清楚，
-- 或者把名字写全（「李钊（研发）」）。
CREATE UNIQUE INDEX idx_stakeholders_name ON stakeholders(name);
CREATE INDEX idx_stakeholders_order ON stakeholders(archived_at, sort_order, name);

-- 负责人：一对多，ON DELETE SET NULL。
-- 删一个干系人不该连带删掉他负责过的需求——那是工作本身，不是他的附属物。
ALTER TABLE objects ADD COLUMN owner_id TEXT REFERENCES stakeholders(id) ON DELETE SET NULL;
CREATE INDEX idx_objects_owner ON objects(owner_id);

-- 参与人：多对多，ON DELETE CASCADE。
-- 这里删干系人就该连带删关联行——关联行本身没有独立意义，
-- 留着就是一条指向不存在的人的记录。和 owner_id 的取舍不同：
-- 那边删掉的是「谁负责」这个信息，工作对象还在；这边删掉的就是关联本身。
CREATE TABLE object_participants (
  object_id      TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  stakeholder_id TEXT NOT NULL REFERENCES stakeholders(id) ON DELETE CASCADE,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (object_id, stakeholder_id)
);
CREATE INDEX idx_object_participants_stakeholder ON object_participants(stakeholder_id);

-- ---------- 存量迁移 ----------
--
-- 把 owner 文本按分隔符拆开：第一段是负责人，其余是参与人。
-- 支持三种分隔符（、 , ，）——用户手打时这三个都会出现，先统一成「、」再拆。
--
-- 软删除的对象一并迁移：它们还能从回收站恢复，恢复时不该丢掉负责人。
-- 但要排掉字面值 'me'——那是 store.DefaultActor.Name，是「操作来源」的默认值
-- 漏进了 owner 字段（全部集中在早期的演示数据上，现在都在回收站里）。
-- 把它建成干系人的话，用户的名册第一行就会是一个不存在的人。
--
-- 用递归 CTE 而不是写死「最多拆三段」：库里现在最多是三个人，
-- 但这是当前数据的巧合，不是规律。写死段数的话，将来手工塞进一条四个人的记录，
-- 第四个人会被静默丢掉——而这类丢失不报错、不崩溃，只是那个人从此不在名单里。
CREATE TEMP TABLE owner_parts AS
WITH RECURSIVE parts(object_id, seq, name, rest) AS (
  SELECT
    id,
    0,
    NULL,
    replace(replace(trim(owner), ',', '、'), '，', '、') || '、'
  FROM objects
  WHERE trim(owner) <> '' AND trim(owner) <> 'me'
  UNION ALL
  SELECT
    object_id,
    seq + 1,
    trim(substr(rest, 1, instr(rest, '、') - 1)),
    substr(rest, instr(rest, '、') + 1)
  FROM parts
  WHERE rest <> ''
)
SELECT object_id, seq, name FROM parts WHERE name IS NOT NULL AND name <> '';

-- 建干系人。id 用 'stk_' + 16 位十六进制随机数：长度与应用侧 idgen 一致，
-- 字母表不同（十六进制 vs base32），一眼能看出这批是迁移生成的。
INSERT INTO stakeholders (id, name, role, email, note, color, sort_order, archived_at, created_at, updated_at)
SELECT
  'stk_' || lower(hex(randomblob(8))),
  name,
  '',
  '',
  '由 0010 迁移从 objects.owner 自动创建，角色与联系方式待补充',
  '',
  0,
  NULL,
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
FROM (SELECT DISTINCT name FROM owner_parts ORDER BY name);

-- 第一段 → 负责人
UPDATE objects
SET owner_id = (
  SELECT s.id
  FROM owner_parts p
  JOIN stakeholders s ON s.name = p.name
  WHERE p.object_id = objects.id AND p.seq = 1
)
WHERE trim(owner) <> '' AND trim(owner) <> 'me';

-- 其余段 → 参与人
INSERT INTO object_participants (object_id, stakeholder_id, sort_order)
SELECT p.object_id, s.id, p.seq
FROM owner_parts p
JOIN stakeholders s ON s.name = p.name
WHERE p.seq > 1;

DROP TABLE owner_parts;
