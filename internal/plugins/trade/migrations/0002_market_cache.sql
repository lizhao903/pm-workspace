-- 0002_market_cache: 行情缓存（TRD-02a）
--
-- trade_klines 存收盘了的 K 线，主键 (symbol, interval, open_time)；open_time 是开盘时间的 Unix 毫秒（UTC 对齐），
-- interval 是 1m、5m、15m、1h、4h、1d、1w 之一。还没收盘的那根不落库，放内存。
-- trade_kline_spans 记已经向交易所取过的区间（开盘时间，含两端），相邻、重叠的合并成一条；
-- 查询区间被某一条完整覆盖时直接读 trade_klines，不再请求交易所。
-- trade_quotes 是每个标的最近一次取到的最新价，30 秒落一次；交易所连不上、刚重启时拿它降级显示，并标出数据时间。
-- at 是交易所给的数据时间，fetched_at 是本机取到的时间，都是 RFC3339 UTC。

CREATE TABLE trade_klines (
  symbol    TEXT NOT NULL,
  interval  TEXT NOT NULL,
  open_time INTEGER NOT NULL,
  open      REAL NOT NULL,
  high      REAL NOT NULL,
  low       REAL NOT NULL,
  close     REAL NOT NULL,
  volume    REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (symbol, interval, open_time)
);

CREATE TABLE trade_kline_spans (
  symbol     TEXT NOT NULL,
  interval   TEXT NOT NULL,
  from_time  INTEGER NOT NULL,
  to_time    INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol, interval, from_time)
);

CREATE TABLE trade_quotes (
  symbol     TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  last       REAL NOT NULL,
  bid        REAL NOT NULL DEFAULT 0,
  ask        REAL NOT NULL DEFAULT 0,
  open_24h   REAL NOT NULL DEFAULT 0,
  high_24h   REAL NOT NULL DEFAULT 0,
  low_24h    REAL NOT NULL DEFAULT 0,
  volume_24h REAL NOT NULL DEFAULT 0,
  at         TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL
);
