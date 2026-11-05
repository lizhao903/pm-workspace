-- 0015_fde_forward: 手动转任务后的 FDE 反馈转发（TSK-0468）
--
-- 我在 IM 消息页手动把消息转成任务（转任务、拆分任务）后，发起内置 SOP「FDE 反馈转发」（sop_im_fde_forward）。
-- im_fde_forwards 是一次转发：id 是主消息 id，message_ids 是这一组消息（拆分任务时会话带的那组，JSON 数组），
-- task_ids 是这次的任务（拆分时一条条并进来，JSON 数组）。status：pending 攒着等发，started 已发起（run_id 是发起时回的运行 id，执行关联在第一条任务上），
-- failed 发起失败（error，比如流程被删了），都不再发。due_at 是什么时候发：转任务马上，拆分时每来一条任务往后推一段。
-- im_fde_forward_messages 按消息占位：一条消息只属于一次转发，所以同一条消息只发一次。时间用定长毫秒 UTC，同 0001。

CREATE TABLE im_fde_forwards (
  id          TEXT PRIMARY KEY,
  message_ids TEXT NOT NULL DEFAULT '[]',
  task_ids    TEXT NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL,
  due_at      TEXT NOT NULL,
  run_id      TEXT NOT NULL DEFAULT '',
  error       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX im_fde_forwards_due ON im_fde_forwards(status, due_at);

CREATE TABLE im_fde_forward_messages (
  message_id TEXT PRIMARY KEY,
  forward_id TEXT NOT NULL REFERENCES im_fde_forwards(id) ON DELETE CASCADE
);
