-- 0003_alerts: 盯盘提醒和触发记录（TRD-03a）
--
-- trade_alerts 对照原型 web-next/src/tradedata.ts 的 PriceAlert：
--   cond 是 price_above / price_below / pct_above / pct_below / volume_spike / funding_above / iv_above / limit_near；
--   value 的单位跟着条件走（价格、%、倍）；repeat 为 1 时满足就提醒、两次之间至少隔 cooldown_min 分钟，为 0 时触发一次就停；
--   notify 是 app / im / sound 的 JSON 数组；im_connector 是推 IM 用的连接器实例 id，没选 IM 为空串；
--   last_fired_at 是最近一次触发，没触发过为空串，「重新上膛」清掉它。
-- trade_alert_events 对照 AlertEvent：规则删了记录保留（不加外键）。
--   cond、value 是触发时规则的条件和这一刻的当前值，note 是规则备注的快照；
--   im_status 是 IM 推送结果：没选 IM 为空串，unavailable 是工作台还没有给插件的 IM 发送能力、这次没推，im_error 写原因。
-- 时间都是 RFC3339 UTC。

CREATE TABLE trade_alerts (
  id            TEXT PRIMARY KEY,
  symbol        TEXT NOT NULL,
  cond          TEXT NOT NULL,
  value         REAL NOT NULL,
  repeat        INTEGER NOT NULL DEFAULT 0,
  cooldown_min  INTEGER NOT NULL DEFAULT 0,
  notify        TEXT NOT NULL DEFAULT '["app"]',
  im_connector  TEXT NOT NULL DEFAULT '',
  enabled       INTEGER NOT NULL DEFAULT 1,
  note          TEXT NOT NULL DEFAULT '',
  last_fired_at TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX trade_alerts_by_enabled ON trade_alerts(enabled, symbol);

CREATE TABLE trade_alert_events (
  id        TEXT PRIMARY KEY,
  alert_id  TEXT NOT NULL,
  symbol    TEXT NOT NULL,
  cond      TEXT NOT NULL,
  value     REAL NOT NULL DEFAULT 0,
  text      TEXT NOT NULL,
  price     REAL NOT NULL DEFAULT 0,
  note      TEXT NOT NULL DEFAULT '',
  at        TEXT NOT NULL,
  read      INTEGER NOT NULL DEFAULT 0,
  im_status TEXT NOT NULL DEFAULT '',
  im_error  TEXT NOT NULL DEFAULT ''
);

CREATE INDEX trade_alert_events_by_at ON trade_alert_events(at DESC);
CREATE INDEX trade_alert_events_unread ON trade_alert_events(read, at);
