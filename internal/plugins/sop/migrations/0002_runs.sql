-- 0002_runs: SOP 执行记录（SOP-01b）
--
-- 对照原型 web-next/src/sopflow.ts 的 SopRun、RunStep。一次执行一行 sop_runs，每个步骤一行 sop_run_steps，
-- 步骤顺序（idx）和开始时的流程快照里的 steps 一致。
-- flow 是开始执行时的整条流程定义（SopFlow 的 JSON），之后改了流程，进行中的执行仍按快照走完；流程删了执行记录照留。
-- status 是由步骤算出的运行状态（同原型 runStatus），每次写步骤时一起更新，只为了按状态筛。
-- wake_at 是等待节点的到点时间，child_run_id 是子流程节点起的子执行，服务重启后据此接着等。
-- 时间用 RFC3339 UTC，精确到毫秒。

CREATE TABLE sop_runs (
  id            TEXT PRIMARY KEY,
  flow_id       TEXT NOT NULL,
  flow_version  INTEGER NOT NULL,
  title         TEXT NOT NULL,
  flow          TEXT NOT NULL,
  input         TEXT NOT NULL DEFAULT '{}',
  step_through  INTEGER NOT NULL DEFAULT 0,
  stopped       INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'running',
  parent_run_id TEXT,
  parent_step   TEXT,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  updated_at    TEXT NOT NULL
);

CREATE INDEX sop_runs_by_flow ON sop_runs(flow_id, started_at);
CREATE INDEX sop_runs_by_status ON sop_runs(status, started_at);
CREATE INDEX sop_runs_by_started ON sop_runs(started_at);

CREATE TABLE sop_run_steps (
  run_id       TEXT NOT NULL REFERENCES sop_runs(id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,
  step_key     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  input        TEXT,
  output       TEXT,
  route        TEXT NOT NULL DEFAULT '',
  route_reason TEXT NOT NULL DEFAULT '',
  error        TEXT NOT NULL DEFAULT '',
  edited       TEXT NOT NULL DEFAULT '',
  attempts     INTEGER NOT NULL DEFAULT 0,
  log          TEXT NOT NULL DEFAULT '[]',
  started_at   TEXT,
  ended_at     TEXT,
  wake_at      TEXT,
  child_run_id TEXT,
  PRIMARY KEY (run_id, idx)
);
