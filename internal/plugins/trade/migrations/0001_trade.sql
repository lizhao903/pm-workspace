-- 0001_trade: 交易套件插件的标的和自选分组（TRD-01a）
--
-- trade_instruments 对照原型 web-next/src/tradedata.ts 的 Instrument，主键是全局 symbol（BINANCE:BTCUSDT、SSE:600519）。
-- 只存静态信息；原型里模拟用的 base、vol 不落表，价格从行情源现取。
-- opt_right 是期权的看涨看跌（call / put，right 是 SQL 关键字），price_limit 是 A 股涨跌停幅度，0 表示没有。
-- expiry、underlying、strike、opt_right 只有期货、期权才有，没有为空串或 0。
-- source 是最近一次同步它的行情源 id。
--
-- trade_watchlists 对照 Watchlist：symbols 是有序的 symbol JSON 数组，不要求已在 trade_instruments 里。
-- position 决定分组顺序，新建的排最后。时间用 RFC3339 UTC。

CREATE TABLE trade_instruments (
  symbol      TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  market      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  venue       TEXT NOT NULL,
  digits      INTEGER NOT NULL DEFAULT 2,
  lot         REAL NOT NULL DEFAULT 1,
  multiplier  REAL NOT NULL DEFAULT 1,
  expiry      TEXT NOT NULL DEFAULT '',
  underlying  TEXT NOT NULL DEFAULT '',
  strike      REAL NOT NULL DEFAULT 0,
  opt_right   TEXT NOT NULL DEFAULT '',
  price_limit REAL NOT NULL DEFAULT 0,
  source      TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL
);

CREATE INDEX trade_instruments_by_market ON trade_instruments(market, kind);

CREATE TABLE trade_watchlists (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  symbols    TEXT NOT NULL DEFAULT '[]',
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
