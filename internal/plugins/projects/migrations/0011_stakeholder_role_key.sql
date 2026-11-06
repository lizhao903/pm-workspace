-- 0011_stakeholder_role_key: 干系人角色改用内核字典 project_role（TSK-0718）
--
-- 0001 的 role 列带 CHECK，只认内置五个 key；插件迁移只能建表、建索引、加列，去不掉这个 CHECK。
-- 所以加一列 role_key 存字典里的 key，读的时候 role_key 非空用它、空用 role（老数据不迁移即可对上）。
-- 写入时 role_key 总是写；role 列在 key 是内置五个之一时写同一个值，不是时写 'member' 只为满足 CHECK，不再当真。
-- 内核统计字典引用数（设置 / 枚举值的「使用中」、删除前检查）按同一个规则算。

ALTER TABLE projects_stakeholders ADD COLUMN role_key TEXT NOT NULL DEFAULT '';
