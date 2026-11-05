-- 0006_strategy_runs: 策略部署到模拟盘（TRD-05b）
--
-- 「部署」是策略在一个账户上长期跑，和 SOP 的「执行」（一次跑完）分开建模，不用 SOP 运行表。
-- trade_runs 对照原型 StrategyRun：strategy_snapshot 是部署那一刻的策略 JSON（之后改策略、删策略都不影响这次部署的规则）；
-- symbols 是 JSON 数组；params 是策略参数加本次覆盖（JSON 对象，键序同策略）；capital_e8 是分配资金（1e8 放大的整数）。
-- status 是 running / paused / stopped / error；error 是异常原因，stopped_at、stop_reason 是停止时间和原因，没有为空串。
-- last_bars 是每个标的已经算过信号的最后一根 K 线的开盘时间（{symbol: Unix 毫秒} 的 JSON），
-- 后端重启后从这里接着算：中间错过的 K 线补算信号、写日志，但不补下单。
-- 盈亏不落表，按 trade_fills 里 run_id 是它的成交重放现算。
--
-- trade_run_logs 是部署日志（信号、下单、成交、风控拦截、启停、补算），level 是 info / warn / error；id 自增。
-- 时间都是毫秒精度的 RFC3339 UTC。

CREATE TABLE trade_runs (
  id                TEXT PRIMARY KEY,
  strategy_id       TEXT NOT NULL,
  strategy_snapshot TEXT NOT NULL,
  account_id        TEXT NOT NULL,
  symbols           TEXT NOT NULL,
  params            TEXT NOT NULL DEFAULT '{}',
  capital_e8        INTEGER NOT NULL,
  status            TEXT NOT NULL,
  error             TEXT NOT NULL DEFAULT '',
  stopped_at        TEXT NOT NULL DEFAULT '',
  stop_reason       TEXT NOT NULL DEFAULT '',
  last_bars         TEXT NOT NULL DEFAULT '{}',
  started_at        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX trade_runs_by_status ON trade_runs(status, started_at);
CREATE INDEX trade_runs_by_strategy ON trade_runs(strategy_id, started_at);

CREATE TABLE trade_run_logs (
  id     INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  at     TEXT NOT NULL,
  level  TEXT NOT NULL,
  text   TEXT NOT NULL
);

CREATE INDEX trade_run_logs_by_run ON trade_run_logs(run_id, id);
