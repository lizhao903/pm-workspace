-- 0019_notifications: 通知（CORE-07b）
--
-- 一行是一条给人看的提醒：任务提交验收、执行结束，以后还有消息到达、提醒触发。
-- 由内核订阅事件总线生成，前端列表展示、标记已读；推送走 GET /api/events 的 notification.created。
--
-- kind 是来源事件类型（task.review_requested、run.finished…）；level 是 info / success / error。
-- object_id 指向相关对象，可空；data 是 JSON，放 run_id 这类跳转用的 id。
-- at、read_at 用定长毫秒 UTC（2006-01-02T15:04:05.000Z），按字符串比较就是按时间比较；read_at 为空即未读。
-- 表名不带下划线：插件表都是「插件 id_」开头，不会撞上。

CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  at         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  level      TEXT NOT NULL DEFAULT 'info',
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  object_id  TEXT NOT NULL DEFAULT '',
  data       TEXT NOT NULL DEFAULT '{}',
  read_at    TEXT
);

CREATE INDEX idx_notifications_at ON notifications(at);
CREATE INDEX idx_notifications_unread ON notifications(read_at, at);
