-- 0018_audits: 审计日志（CORE-08）
--
-- 一行是一次已成功的操作：配置变更（类型、字典、服务商、插件、保险箱）、删除、Agent 写操作、下单。
-- 只插入不更新，写入在业务事务提交之后另起一次，审计写失败只记日志，不让业务写入失败。
--
-- kind 是分组：config / delete / agent / order。action 是动词（create、update、delete、rotate…），
-- target_type + target_id 指向被操作的东西（object、dict_item、secret、plugin…）。
-- actor 和 revisions.actor 同一写法（名字#会话），source 是 X-Actor-Source。
-- detail 是 JSON，凭证只记「已设置 / 已更新」这类提示，不记明文、密文和脱敏尾号。
--
-- at 用定长毫秒 UTC（2006-01-02T15:04:05.000Z），按字符串比较就是按时间比较。
-- 表名不带下划线：插件表都是「插件 id_」开头，不会撞上。

CREATE TABLE audits (
  id           TEXT PRIMARY KEY,
  at           TEXT NOT NULL,
  kind         TEXT NOT NULL,
  action       TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    TEXT NOT NULL DEFAULT '',
  actor        TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL DEFAULT '',
  summary      TEXT NOT NULL DEFAULT '',
  detail       TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_audits_at ON audits(at);
CREATE INDEX idx_audits_target ON audits(target_type, target_id, at);
CREATE INDEX idx_audits_actor ON audits(actor, at);
