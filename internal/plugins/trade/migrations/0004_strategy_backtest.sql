-- 0004_strategy_backtest: 策略和回测记录（TRD-04b）
--
-- trade_strategies 对照原型 web-next/src/tradedata.ts 的 Strategy。body 是整份策略的 JSON（同 Strategy 的形状，
-- id、created_at、updated_at 以列为准）；name 单独存一列只为排序和日志。时间用 RFC3339 UTC。
--
-- trade_backtests 对照 Backtest：config 是 BacktestConfig 的 JSON，strategy_snapshot 是发起那一刻的策略副本，
-- 之后改策略、删策略都不影响这条。status 是 queued / running / done / failed；progress 是 0 到 1。
-- result 是 BacktestResult 的 JSON，完成前为空串；stats、note 是从 result 里抄出来的统计 JSON 和说明，列表只读这两列不解整份结果；error 是失败原因，开头写明是「数据缺失」「参数不合法」还是「引擎错误」。
-- seq 是这个策略的第几次回测，name 是「<策略名> #<seq>」。
-- data_from、data_to 是实际用到的第一根、最后一根 K 线的开盘时间（Unix 毫秒），参数扫描按同一段数据重算；没跑完为 0。
-- sweep 是最近一次参数扫描的结果（{param, points, at} 的 JSON），没扫过为空串；扫描不新增回测记录。
-- 策略删了回测记录保留（strategy_id 不建外键）。后端重启时 running 的改成 failed（可以重跑），queued 的接着排队。

CREATE TABLE trade_strategies (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE trade_backtests (
  id                TEXT PRIMARY KEY,
  strategy_id       TEXT NOT NULL,
  seq               INTEGER NOT NULL DEFAULT 1,
  name              TEXT NOT NULL,
  config            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'queued',
  progress          REAL NOT NULL DEFAULT 0,
  strategy_snapshot TEXT NOT NULL,
  result            TEXT NOT NULL DEFAULT '',
  stats             TEXT NOT NULL DEFAULT '',
  note              TEXT NOT NULL DEFAULT '',
  error             TEXT NOT NULL DEFAULT '',
  data_from         INTEGER NOT NULL DEFAULT 0,
  data_to           INTEGER NOT NULL DEFAULT 0,
  sweep             TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL,
  started_at        TEXT NOT NULL DEFAULT '',
  finished_at       TEXT NOT NULL DEFAULT ''
);

CREATE INDEX trade_backtests_by_strategy ON trade_backtests(strategy_id, created_at);

CREATE INDEX trade_backtests_by_status ON trade_backtests(status, created_at);
