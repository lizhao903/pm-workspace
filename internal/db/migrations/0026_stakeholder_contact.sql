-- 0026_stakeholder_contact: 联系人字段（CT-01a）
--
-- 联系人沿用干系人名册，不另建表：负责人、参与人、联系人是同一批人，分两张表就得同步改名。
-- 只加列，0010 的列和唯一索引不动；name 仍全局唯一，重名的人要在名字里加区分（如「王磊（北岸）」）。
-- 字段对照原型 web-next/src/data.ts 的 Contact；im（各渠道账号）留给 CT-01b 的 IM 身份表。
--
-- contact_group 是分组的显示名（客户、合作伙伴……），分组可在设置里新增，这里不约束取值。
-- 列名不用 group，那是 SQL 关键字；接口字段仍叫 group。
-- tags 存 JSON 字符串数组；photo 是 data:image/ 开头的 data URL，空串表示按名字生成头像。
-- last_contact_at 为 NULL 表示没联系过。

ALTER TABLE stakeholders ADD COLUMN contact_group TEXT NOT NULL DEFAULT '';
ALTER TABLE stakeholders ADD COLUMN company TEXT NOT NULL DEFAULT '';
ALTER TABLE stakeholders ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE stakeholders ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE stakeholders ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE stakeholders ADD COLUMN photo TEXT NOT NULL DEFAULT '';
ALTER TABLE stakeholders ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stakeholders ADD COLUMN last_contact_at TEXT;
