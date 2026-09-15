-- 对象的专属工作区目录。主要挂在 project 上：切到某个项目时，Agent 与 Claude Code
-- 的产物落到它自己的目录；任务自身没设时向上取所属项目的。
-- 不建索引：workdir 只按 id 取，从不作为查询条件，索引纯属净成本。
ALTER TABLE objects ADD COLUMN workdir TEXT NOT NULL DEFAULT '';
