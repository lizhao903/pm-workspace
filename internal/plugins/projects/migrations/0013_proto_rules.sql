-- 0013_proto_rules: 原型规则（TSK-0841 复盘：后台执行没在基础原型上改，另做了一个独立 HTML）
--
-- 项目登记的每个原型（projects_prototypes）和项目档案的原型库（projects_profiles.proto_dir）都能写一段规则：
-- 在哪个分支上改、以哪份设计为准、改完在哪里提交等。多行纯文本，空串表示没有规则。
-- 交给 Claude Code / DeepSeek 执行时，规则跟在提示词「原型在哪里操作」对应的原型后面。
-- 只加列：老数据读出来是空规则，提示词和以前一样。

ALTER TABLE projects_prototypes ADD COLUMN rules TEXT NOT NULL DEFAULT '';
ALTER TABLE projects_profiles ADD COLUMN proto_rules TEXT NOT NULL DEFAULT '';
