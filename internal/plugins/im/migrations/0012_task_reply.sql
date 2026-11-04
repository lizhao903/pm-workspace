-- 0012_task_reply: IM 转出的任务执行完成后回复原消息（SPEC-messages-2.50）
--
-- im_task_waits 是 SOP「等任务执行完成」节点挂起中的等待，同 0004 的 im_sop_waits：节点执行时落一行、步骤挂起；
-- 任务执行成功结束（内核 run.finished，ok 为真）或任务改成已完成（object.status_changed）时记下 done_via 和结论，
-- 后台任务 task_waits 据此唤醒步骤（Core.SOP().Resume），到 deadline 还没完成就让步骤失败，之后删掉这一行。
-- done_via：'' 还在等，'run' 执行成功结束，'status' 任务标成已完成。summary 是执行的结论开头（run.finished 带的）。
-- task_id 是内核对象 id，不建外键：任务删了就等到超时。
--
-- im_sop_templates 记本插件写进 SOP 的内置流程（同视频插件的 video_sop_templates）：写过一次就不再写，
-- 用户删掉内置流程后不会被偷偷加回来；转任务时要用它，没写过的现写。

CREATE TABLE im_task_waits (
  run_id    TEXT NOT NULL,
  step      TEXT NOT NULL,
  attempt   INTEGER NOT NULL,
  task_id   TEXT NOT NULL,
  input     TEXT NOT NULL DEFAULT '{}',
  since     TEXT NOT NULL,
  deadline  TEXT NOT NULL,
  done_via  TEXT NOT NULL DEFAULT '',
  summary   TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (run_id, step)
);

CREATE INDEX im_task_waits_by_task ON im_task_waits(task_id);

CREATE TABLE im_sop_templates (
  flow_id      TEXT PRIMARY KEY,
  installed_at TEXT NOT NULL
);
