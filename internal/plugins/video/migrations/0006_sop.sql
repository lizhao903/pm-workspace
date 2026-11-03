-- 0006_sop: SOP 节点挂起中的等待、写进 SOP 的内置流程（VID-03d）
--
-- video_sop_waits：节点执行时落一行、步骤挂起（plugin.ErrWaiting），后台任务看到结果后唤醒或让步骤失败，之后删掉。
-- 存在库里是为了服务重启后接着等：SOP 那边挂起的步骤重启后不重跑。一次执行的一个步骤只有一行，重试后按 attempt 覆盖。
-- kind 是 checkpoint（等检查点通过，stage 是检查点所在阶段）或 stage（等阶段执行器跑完，video_run_id 是 video_runs 的那一行）。
-- input 是这一步的输入（JSON），唤醒时原样带上。不建外键：视频删了由后台任务让步骤失败。
--
-- video_sop_templates：已经写进 SOP 的内置流程，写过一次就不再写，用户删了也不补回来；卸载时撤下没改过的再删这一行。
-- 时间用 RFC3339 UTC。

CREATE TABLE video_sop_waits (
  run_id       TEXT NOT NULL,
  step         TEXT NOT NULL,
  attempt      INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  video_id     TEXT NOT NULL,
  stage        TEXT NOT NULL,
  video_run_id INTEGER,
  input        TEXT NOT NULL DEFAULT '{}',
  since        TEXT NOT NULL,
  PRIMARY KEY (run_id, step)
);

CREATE TABLE video_sop_templates (
  flow_id      TEXT PRIMARY KEY,
  installed_at TEXT NOT NULL
);
