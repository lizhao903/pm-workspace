-- 0014_task_ack: SOP「回执需求方」节点（im_ack_task，TSK-0467）按消息记的回执
--
-- IM 消息转成任务后，在原消息所在的会话（在消息列里的回在消息列里）回复需求方一句「已创建任务 TSK-x，开始进行需求规划」。
-- 同一条消息只回一次：不管是重跑、还是几条流程都为这条消息建了（或取回了）任务，第一个占到这一行的发，别的看到这一行就不发。
-- status：sending 正在发（占位），sent 发成了，failed 发失败（下一次执行可以重新占来再发）。
-- run_id、step、attempt 是占位的那次执行和步骤：服务重启后同一次尝试重跑时认得出是自己占的，按审计查发没发过。
-- task_id、task_ref 是回执里说的任务；reply_id 是 im_replies 的那一行，external_id 是渠道里的编号。时间用定长毫秒 UTC，同 0001。

CREATE TABLE im_task_acks (
  message_id  TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL DEFAULT '',
  task_ref    TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL,
  run_id      TEXT NOT NULL DEFAULT '',
  flow_id     TEXT NOT NULL DEFAULT '',
  step        TEXT NOT NULL DEFAULT '',
  attempt     INTEGER NOT NULL DEFAULT 0,
  text        TEXT NOT NULL DEFAULT '',
  reply_id    TEXT NOT NULL DEFAULT '',
  external_id TEXT NOT NULL DEFAULT '',
  error       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
