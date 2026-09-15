-- 0009_task_runs: 把一个工作对象交给本机 claude 执行的记录
--
-- 一次执行 = 一行。这类执行的价值在过程而不只在结果：事后要能复查它到底跑了什么
-- 提示词、在哪个目录里动的手、说了什么。所以 prompt 和 output 都整条存下来，
-- 而不是只留一个成功/失败标志。
--
-- output 用 TEXT 不用 BLOB：它就是文本，BLOB 会让手工 sqlite3 排查时读不出来。
-- 它可能很大（一次长跑动辄几百 KB），截断策略放在 internal/runner：
-- 超过 1MB 只落前 1MB 并在末尾标注，完整输出写进 workdir 下的 .pmw-runs/<id>.log。
-- 不在这层加 CHECK 限长——SQL 报错只会让整次执行的记录彻底丢失，
-- 比留一段截断过的输出糟得多。
--
-- object_id 走 ON DELETE CASCADE：执行记录脱离了工作对象没有任何意义，
-- 留着只会在库里堆成永远查不到的孤儿。与 agent_sessions.provider_id 的取舍不同——
-- 那边删的是配置、会话本身仍是独立的历史；这边删的是记录所依附的主体。
--
-- workdir 存绝对路径，语义是「这台机器上的这个位置」，没有可移植的相对基准，
-- 和 agent_sessions.workdir 一致。
--
-- exit_code 在未结束时无意义，默认 0；判断有没有跑完一律看 status / finished_at，
-- 不要看 exit_code。finished_at 可空就是「还在跑」的唯一权威标志。

PRAGMA foreign_keys = ON;

CREATE TABLE task_runs (
  id          TEXT PRIMARY KEY,
  object_id   TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  workdir     TEXT NOT NULL DEFAULT '',   -- 绝对路径，claude 的工作目录
  prompt      TEXT NOT NULL DEFAULT '',   -- 实际喂给 claude 的完整提示词
  status      TEXT NOT NULL,              -- pending | running | done | failed | canceled
  exit_code   INTEGER NOT NULL DEFAULT 0,
  output      TEXT NOT NULL DEFAULT '',   -- 渲染后的过程记录，可能已截断
  error       TEXT NOT NULL DEFAULT '',
  started_at  TEXT NOT NULL,
  finished_at TEXT                        -- NULL 表示还在跑
);

-- 详情面板只有一种读法：某个对象的执行历史，最近的在前。
-- id 兜底保证同一秒内起的两次执行顺序稳定（idgen 的 id 本身时间有序）。
CREATE INDEX idx_task_runs_object ON task_runs(object_id, started_at DESC, id DESC);
