-- 0003_run_object: 执行关联到工作对象、记下发起来源（SOP-06）
--
-- object_id 是这次执行关联的内核对象 id（任务等）：在任务详情里「执行 SOP」发起的，或 Agent 处理任务时用 run_sop 发起的。
-- 不是外键：内核表不归本插件管，对象删了执行记录照留，按 id 查不到就当没有关联。子流程起的子执行继承父执行的 object_id。
--
-- source 是谁发起的：manual 界面上手动（SOP 页、任务详情）/ agent Agent 的 run_sop / schedule 定时任务的 sop 动作 /
-- im IM 消息触发（流程触发方式是 IM）/ subflow 子流程节点 / plugin 别的插件经内核运行句柄；以前的执行是空串，界面上不显示来源。
-- source_ref 是来源对象的 id：agent 记 Agent id，schedule 记定时任务 id，im 记消息 id，subflow 记父执行 id，plugin 记插件 id；没有为空串。
-- source_name 是发起那一刻来源的名字（Agent 名、定时任务名、父执行标题、插件 id）：界面优先现查 source_ref 的当前名字，
-- 查不到（改名之外的删除、没权限读）时用它，免得只剩一个 id。
-- 以前的执行 object_id 为 NULL，source、source_ref、source_name 为空串。

ALTER TABLE sop_runs ADD COLUMN object_id TEXT;
ALTER TABLE sop_runs ADD COLUMN source TEXT NOT NULL DEFAULT '';
ALTER TABLE sop_runs ADD COLUMN source_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE sop_runs ADD COLUMN source_name TEXT NOT NULL DEFAULT '';

CREATE INDEX sop_runs_by_object ON sop_runs(object_id, started_at);
