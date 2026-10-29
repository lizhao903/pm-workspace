-- 0005_runners: 阶段执行器和执行记录（VID-03b）
--
-- 对照原型 web-next/src/videodata.ts 的 StageRunner、LastRun。
-- 执行器每个视频每个阶段最多一个，type 是 skill / sop / agent，ref_id 是技能 id、SOP 流程 id 或名称、Agent id 或名称，
-- 插件读不到内核和 sop 的表，只存不查，跑的时候才知道在不在。
-- 执行记录一次一行，视频的 last_run 取最近的一行。run_id 是内核「插件发起运行」（Core.Runs）的运行 id，
-- 发起前先写一行占住（同一视频同一时间只能有一条在跑，靠部分唯一索引），起来后回写；ref 是 Agent 会话 id 或 SOP 执行 id。
-- runner_type、ref_id、prompt 是发起时执行器的快照，之后改执行器不影响这条记录。
-- artifact_ids 是这次登记或升版的产出物（JSON 数组）。运行记录在内核里只留在内存，服务重启后在跑的这里记成失败。

CREATE TABLE video_runners (
  video_id   TEXT NOT NULL REFERENCES video_videos(id) ON DELETE CASCADE,
  stage      TEXT NOT NULL,
  type       TEXT NOT NULL,
  ref_id     TEXT NOT NULL,
  prompt     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (video_id, stage)
);

CREATE TABLE video_runs (
  id           INTEGER PRIMARY KEY,
  video_id     TEXT NOT NULL REFERENCES video_videos(id) ON DELETE CASCADE,
  stage        TEXT NOT NULL,
  type         TEXT NOT NULL,
  runner_type  TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  prompt       TEXT NOT NULL DEFAULT '',
  run_id       TEXT NOT NULL DEFAULT '',
  ref          TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'running',
  error        TEXT NOT NULL DEFAULT '',
  artifact_ids TEXT NOT NULL DEFAULT '[]',
  started_at   TEXT NOT NULL,
  ended_at     TEXT
);

CREATE INDEX video_runs_by_video ON video_runs(video_id, id);
CREATE INDEX video_runs_by_run ON video_runs(run_id) WHERE run_id <> '';
CREATE UNIQUE INDEX video_runs_one_running ON video_runs(video_id) WHERE status = 'running';
