-- 0005_run_relaunched: 失败执行「按最新流程重新发起」后记下重跑到了哪条
--
-- relaunched_to 是这条执行被批量重跑（runbatch.go 的 relaunch）新起的那条执行 id；没被重跑过为 NULL。
-- 有值的失败执行算「已重跑」：不再出现在「失败」「待我处理」、今日卡片里，在「全部」里显示「已重跑」并能点到新执行；
-- 再重跑（retry、relaunch）一律跳过，保证同一条失败执行只重跑一次。
-- 重跑进行中先写占位 pending:<随机串> 抢位（条件更新，并发两次只有一次抢到），建好新执行换成它的 id，建失败清回 NULL。
-- 子流程里失败的子执行重跑的是它的顶层执行：顶层执行和它下面失败的子执行都记同一条新执行 id。
--
-- 插件迁移只能建表、加列、建索引，存量回填不在这里：服务启动时由引擎做（runbatch.go 的 backfillRelaunched，engine.go 的 job），
-- 口径是以前批量重跑新起的执行 source = 'manual'、source_name = '批量重跑'、source_ref = 原（顶层）执行 id，
-- 一条原执行被重跑过多次的取最新那条，再把它下面失败的子执行记成同一条；顺带修掉上次重跑到一半停了留下的占位。

ALTER TABLE sop_runs ADD COLUMN relaunched_to TEXT;
