-- 0043_incidents: 运行异常（INC-01a）
--
-- 系统运行中出的问题集中记一份，对应原型 web-next/src/incidentdata.ts 的 Incident（规格 SPEC-settings-18、19）。
-- 同一个问题按 fingerprint 合并：次数加一、更新 last_at、occurrences 只留最近 20 个；
-- 已忽略、已解决的再出现变回 open（有 task_id 的回 tasked），note 写「标为已解决后又出现了」。
--
-- level：error / warn。status：open / tasked / ignored / resolved。
-- source：frontend（前端上报）/ backend（内核）/ plugin:<插件 id>。
-- context 是 JSON 对象，值可以是对象；occurrences 是 JSON 数组，新的在前，最多 20 个。
-- task_id 是转成的任务（objects.id），不建外键：任务删了异常不跟着删，读的时候发现任务没了退回 open。
-- 时间列用定长毫秒 UTC（2006-01-02T15:04:05.000Z）。

CREATE TABLE incidents (
  id           TEXT PRIMARY KEY,
  fingerprint  TEXT NOT NULL,
  level        TEXT NOT NULL DEFAULT 'error',
  module       TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL DEFAULT '',
  message      TEXT NOT NULL DEFAULT '',
  context      TEXT NOT NULL DEFAULT '{}',
  stack        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open',
  note         TEXT NOT NULL DEFAULT '',
  count        INTEGER NOT NULL DEFAULT 1,
  first_at     TEXT NOT NULL,
  last_at      TEXT NOT NULL,
  occurrences  TEXT NOT NULL DEFAULT '[]',
  task_id      TEXT,
  source       TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX ux_incidents_fingerprint ON incidents(fingerprint);
CREATE INDEX idx_incidents_last ON incidents(last_at);
CREATE INDEX idx_incidents_status ON incidents(status, last_at);
