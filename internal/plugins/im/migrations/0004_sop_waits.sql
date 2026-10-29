-- 0004_sop_waits: SOP「等待回复」节点挂起中的等待（SOP-02b）
--
-- 节点执行时落一行、步骤挂起（plugin.ErrWaiting）；插件后台任务看这个会话里有没有对方的新消息，
-- 有就唤醒步骤（Core.SOP().Resume），到 deadline 还没有就让步骤失败（Core.SOP().Fail），之后删掉这一行。
-- 存在库里是为了服务重启后接着等：SOP 那边挂起的步骤重启后不重跑。
-- 一次执行的一个步骤只有一行，重试、退回重做后再挂起时按 attempt 覆盖。
-- conversation_id 是内核会话 id，不建外键：会话删了就等到超时。input 是这一步的输入（JSON），唤醒时原样带上。
-- 时间用定长毫秒 UTC，同 0001。

CREATE TABLE im_sop_waits (
  run_id                   TEXT NOT NULL,
  step                     TEXT NOT NULL,
  attempt                  INTEGER NOT NULL,
  conversation_id          TEXT NOT NULL,
  channel                  TEXT NOT NULL,
  conversation_external_id TEXT NOT NULL DEFAULT '',
  conversation_name        TEXT NOT NULL DEFAULT '',
  input                    TEXT NOT NULL DEFAULT '{}',
  since                    TEXT NOT NULL,
  deadline                 TEXT NOT NULL,
  PRIMARY KEY (run_id, step)
);

CREATE INDEX im_sop_waits_by_deadline ON im_sop_waits(deadline);
