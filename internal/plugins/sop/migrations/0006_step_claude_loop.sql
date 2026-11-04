-- 0006_step_claude_loop: Claude Code 节点（AUTO-01）和条件回退（AUTO-02）在步骤上记的几样
--
-- claude 是 Claude Code 节点这一步发起的运行（JSON：run_id、task_id、workdir），服务重启、停用再启用后据此接着等；没有为 NULL。
-- round 是这一步当前是第几轮：被条件回退退回重做后记 2、3……，首轮为 0（界面不显示）。
-- rework_reason 是这一轮被退回重做的原因（哪个回退节点、条件怎么成立的），首轮为空。
-- loops 是条件回退节点已经自动退回了几次，到 max_rounds 后走「超限」出口。

ALTER TABLE sop_run_steps ADD COLUMN claude TEXT;
ALTER TABLE sop_run_steps ADD COLUMN round INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sop_run_steps ADD COLUMN rework_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE sop_run_steps ADD COLUMN loops INTEGER NOT NULL DEFAULT 0;
