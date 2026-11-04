-- 0001_etf: 宽基 ETF 的静态元信息与每日份额/交易快照（ETF-01a）
--
-- etf_funds 是宽基 ETF 的静态元信息。symbol 是 6 位代码；secid 是东方财富的证券标识
-- （1.510300 上交所、0.159915 深交所），采集时用它拼接口。category 标宽基/行业/主题/策略，
-- 本插件只登记宽基。份额、净值、行情都不在这里，按日存在 etf_daily。
--
-- etf_daily 一天一只 ETF 一行，主键 (trade_date, symbol)。trade_date 是交易日 YYYY-MM-DD。
-- shares 是基金份额（份）；nav 是单位净值（元）；price/open/high/low 是收盘与当日高低（元）；
-- volume 成交量（手），amount 成交额（元）；change_pct、change_amount 是涨跌幅（%）与涨跌额（元）；
-- amplitude 振幅（%），turnover_rate 换手率（%）；aum 是估算规模（元，= shares × nav）；
-- premium_discount 折溢价（%，= (price - nav) / nav × 100）。
-- source 是最近一次采集它的源 id，updated_at 是写入时间（RFC3339 UTC）。
-- 唯一约束让每日采集可以幂等重跑，同一天同一只覆盖不重复。

CREATE TABLE etf_funds (
  symbol      TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  track_index TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT '宽基',
  manager     TEXT NOT NULL DEFAULT '',
  market      TEXT NOT NULL DEFAULT '',
  secid       TEXT NOT NULL DEFAULT '',
  underlying  TEXT NOT NULL DEFAULT '',
  launch_date TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL
);

CREATE INDEX etf_funds_by_category ON etf_funds(category, market);

CREATE TABLE etf_daily (
  trade_date       TEXT NOT NULL,
  symbol           TEXT NOT NULL,
  shares           REAL NOT NULL DEFAULT 0,
  nav              REAL NOT NULL DEFAULT 0,
  price            REAL NOT NULL DEFAULT 0,
  open             REAL NOT NULL DEFAULT 0,
  high             REAL NOT NULL DEFAULT 0,
  low              REAL NOT NULL DEFAULT 0,
  volume           REAL NOT NULL DEFAULT 0,
  amount           REAL NOT NULL DEFAULT 0,
  change_pct       REAL NOT NULL DEFAULT 0,
  change_amount    REAL NOT NULL DEFAULT 0,
  amplitude        REAL NOT NULL DEFAULT 0,
  turnover_rate    REAL NOT NULL DEFAULT 0,
  aum              REAL NOT NULL DEFAULT 0,
  premium_discount REAL NOT NULL DEFAULT 0,
  source           TEXT NOT NULL DEFAULT '',
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (trade_date, symbol)
);

CREATE INDEX etf_daily_by_symbol ON etf_daily(symbol, trade_date);
