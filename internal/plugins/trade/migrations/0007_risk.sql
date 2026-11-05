-- 0007_risk: 风控规则和熔断记录（TRD-06a）
--
-- trade_risk 对照原型 RiskRules，全局一行（id = 'global'），第一次读的时候按原型的默认值补上：
-- max_position_pct 单标的仓位上限（% 账户权益）、daily_loss_pct 单日亏损上限（% 总权益）、
-- max_order_value 单笔金额上限（USD）、max_leverage 合约最大杠杆（倍）、confirm_above 二次确认阈值（USD）。
-- 规则是阈值不是账本，用 REAL；比较时金额换成 1e8 整数再比。
-- halted 是熔断中；halted_reason、halted_at 是这一次熔断的原因和时间，没熔断为空串；halt_id 是对应的熔断记录。
-- trip_day 是日亏损自动熔断过的那个 UTC 日：同一天回到上限以内之前不再重复自动熔断，回到上限以内时清空。
--
-- trade_halts 是熔断记录（原型 HaltRec）：kind 是 manual（一键全停）/ auto（日亏损自动熔断）；
-- runs_stopped、orders_canceled 是那一次停掉的部署、撤掉的委托数；released_at、release_reason 是解除时间和原因，没解除为空串。
-- 时间都是毫秒精度的 RFC3339 UTC。

CREATE TABLE trade_risk (
  id               TEXT PRIMARY KEY,
  max_position_pct REAL NOT NULL,
  daily_loss_pct   REAL NOT NULL,
  max_order_value  REAL NOT NULL,
  max_leverage     REAL NOT NULL,
  confirm_above    REAL NOT NULL,
  halted           INTEGER NOT NULL DEFAULT 0,
  halted_reason    TEXT NOT NULL DEFAULT '',
  halted_at        TEXT NOT NULL DEFAULT '',
  halt_id          TEXT NOT NULL DEFAULT '',
  trip_day         TEXT NOT NULL DEFAULT '',
  updated_at       TEXT NOT NULL
);

CREATE TABLE trade_halts (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  reason          TEXT NOT NULL,
  at              TEXT NOT NULL,
  runs_stopped    INTEGER NOT NULL DEFAULT 0,
  orders_canceled INTEGER NOT NULL DEFAULT 0,
  released_at     TEXT NOT NULL DEFAULT '',
  release_reason  TEXT NOT NULL DEFAULT ''
);

CREATE INDEX trade_halts_by_at ON trade_halts(at DESC);
