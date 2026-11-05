-- 0002_anomaly: 宽基异动监控（ETF-01b），设计见 docs/etf-anomaly-design.md
--
-- etf_daily 加两列：iopv 是盘中参考净值（元，只有采集最近交易日时能拿到，历史日期为 0）；
-- premium_basis 是折溢价的口径：iopv（按 IOPV 算）/ nav（没有 IOPV 时按单位净值算）/ none（两样都没有，折溢价不可用）。
--
-- etf_index_daily 是跟踪指数的日行情，主键 (trade_date, index_code)；index_code 是 6 位指数代码（000300、399006…），
-- close 收盘点位，change_pct 涨跌幅（%），amount 成交额（元）。跟踪误差和超额收益的基准。
--
-- etf_metrics_daily 是每日派生指标，一天一只一行，采集后算好落库，查询不现算窗口。
-- 样本不够的指标存 NULL，接口回 null，判定时跳过：
--   share_change_pct 份额日变动（%），net_inflow 估算净流入（元，= 份额差 × 净值，没有净值用收盘价），
--   inflow_streak 连续净流入天数（正）/ 连续净流出天数（负），份额不变记 0；
--   amount_ratio 量比 = 当日成交额 / 之前 20 个交易日均额（不含当日），之前不足 20 天为 NULL；
--   share_pctile、aum_pctile、premium_pctile 是当日值在近 250 个交易日里的分位（0-100），样本不足 60 天为 NULL；
--   tracking_error 近 20 日（ETF 日收益 - 指数日收益）的样本标准差年化（× √252，%），不足 20 个配对日为 NULL；
--   excess_return 近 20 日 ETF 累计收益减指数累计收益（%），样本同上；
--   aum_change_pct 规模日变动（%）；premium_discount、premium_basis 同 etf_daily 当天；
--   review_flag 非空表示待核：pending_review 是份额单日变动超过 10% 且量比不到 2（没有行情配合），
--   疑似分红、拆分、份额折算，份额类规则命中时标记待核。
--
-- etf_anomaly_rules 是规则，一条规则 = 一个指标 + 比较 + 阈值。id 是 ear_ 前缀，首批 7 条用固定 id 由插件补种
-- （迁移里不能写数据），用户改过的不覆盖。scope：all 全部 / symbol 只看 scope_value 这一只 / index 只看跟踪
-- scope_value 这个指数的。operator：gt / gte / lt / lte / abs_gt（绝对值大于）。severity：info / warn / critical。
-- window_days 是指标的窗口（量比、跟踪误差 20，其余 1），目前只做展示，指标窗口固定。
--
-- etf_anomaly_events 是命中记录，id 是 eae_ 前缀，同日同标的同规则只留一条（唯一约束）。重跑覆盖值不改 status：
-- open 未处理 / acked 已确认 / ignored 已忽略；handled_at 是确认或忽略的时间。flag 是 pending_review 时为待核。

ALTER TABLE etf_daily ADD COLUMN iopv REAL NOT NULL DEFAULT 0;

ALTER TABLE etf_daily ADD COLUMN premium_basis TEXT NOT NULL DEFAULT '';

CREATE TABLE etf_index_daily (
  trade_date  TEXT NOT NULL,
  index_code  TEXT NOT NULL,
  close       REAL NOT NULL DEFAULT 0,
  change_pct  REAL NOT NULL DEFAULT 0,
  amount      REAL NOT NULL DEFAULT 0,
  source      TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (trade_date, index_code)
);

CREATE TABLE etf_metrics_daily (
  trade_date        TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  share_change_pct  REAL,
  net_inflow        REAL,
  inflow_streak     INTEGER NOT NULL DEFAULT 0,
  amount_ratio      REAL,
  share_pctile      REAL,
  aum_pctile        REAL,
  premium_pctile    REAL,
  tracking_error    REAL,
  excess_return     REAL,
  aum_change_pct    REAL,
  premium_discount  REAL,
  premium_basis     TEXT NOT NULL DEFAULT '',
  review_flag       TEXT NOT NULL DEFAULT '',
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (trade_date, symbol)
);

CREATE INDEX etf_metrics_by_symbol ON etf_metrics_daily(symbol, trade_date);

CREATE TABLE etf_anomaly_rules (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'all',
  scope_value TEXT NOT NULL DEFAULT '',
  metric      TEXT NOT NULL,
  operator    TEXT NOT NULL,
  threshold   REAL NOT NULL,
  window_days INTEGER NOT NULL DEFAULT 1,
  severity    TEXT NOT NULL DEFAULT 'warn',
  enabled     INTEGER NOT NULL DEFAULT 1,
  builtin     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE etf_anomaly_events (
  id          TEXT PRIMARY KEY,
  trade_date  TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  rule_id     TEXT NOT NULL,
  rule_name   TEXT NOT NULL DEFAULT '',
  metric      TEXT NOT NULL,
  value       REAL NOT NULL,
  threshold   REAL NOT NULL,
  operator    TEXT NOT NULL DEFAULT '',
  severity    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  flag        TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  handled_at  TEXT NOT NULL DEFAULT '',
  UNIQUE (trade_date, symbol, rule_id)
);

CREATE INDEX etf_anomaly_events_by_date ON etf_anomaly_events(trade_date, severity);
