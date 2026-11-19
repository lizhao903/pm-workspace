-- 0014_run_allow: 项目执行白名单（TSK-0837 复盘：后台执行常用操作被权限拒绝）
--
-- 项目档案加一列 run_allow：Claude Code 的权限规则数组（JSON，如 ["Bash(./_shared/新建需求.sh:*)", "Read(//Volumes/docs/PRDs/**)"]），
-- 校验同「设置 / 执行权限」的自定义白名单（runner.CheckRule，最多 100 条、每条最多 200 字符）。
-- 任务属于这个项目、交给 Claude Code 后台执行时合进 --allowedTools：写入档位全部合并，只读档位只合并 Read(...) 这类读规则。
-- 只加列：老数据读出来是空数组，执行时和以前一样。

ALTER TABLE projects_profiles ADD COLUMN run_allow TEXT NOT NULL DEFAULT '[]';
