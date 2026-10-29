-- 0002_artifacts: 视频产出物和验收记录（VID-01b）
--
-- 对照原型 web-next/src/videodata.ts 的 Artifact、Review。原型的 option 列名改成 option_no。
-- 产出物放插件自己的表，不进内核 artifacts：插件只能建、读写本插件前缀的表。
-- path 存相对视频工程目录（video_videos.root）的路径，插件保证不越出工程目录；variant 没有存空串。
-- 升版本在原行上 version 加一（同原型「升版本」）；验收记录一条一行，带上验收时的版本号，升版本后旧版的记录照留。
-- 来源同原型 source：source_type 是 manual / sop / agent / skill，source_label 是当时的名字快照，
-- source_id 是 Agent id、SOP 流程 id 或技能名；session_id、run_id、core_artifact_id 是内核产物溯源（AG-03b）的
-- 会话、运行和内核产物 id，插件读不到内核表，只存不查，不建外键。
-- 同一视频同一类型同一比例的方案序号唯一；选用的封面同组只能有一张。

CREATE TABLE video_artifacts (
  id               TEXT PRIMARY KEY,
  video_id         TEXT NOT NULL REFERENCES video_videos(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  name             TEXT NOT NULL,
  path             TEXT NOT NULL,
  variant          TEXT NOT NULL DEFAULT '',
  option_no        INTEGER,
  version          INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'draft',
  duration         INTEGER,
  picked           INTEGER NOT NULL DEFAULT 0,
  source_type      TEXT NOT NULL DEFAULT 'manual',
  source_label     TEXT NOT NULL DEFAULT '',
  source_id        TEXT NOT NULL DEFAULT '',
  session_id       TEXT NOT NULL DEFAULT '',
  run_id           TEXT NOT NULL DEFAULT '',
  core_artifact_id TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX video_artifacts_by_video ON video_artifacts(video_id, created_at);
CREATE UNIQUE INDEX video_artifacts_option ON video_artifacts(video_id, kind, variant, option_no) WHERE option_no IS NOT NULL;
CREATE UNIQUE INDEX video_artifacts_picked ON video_artifacts(video_id, kind, variant) WHERE picked = 1;
CREATE INDEX video_artifacts_by_run ON video_artifacts(run_id) WHERE run_id <> '';
CREATE INDEX video_artifacts_by_session ON video_artifacts(session_id) WHERE session_id <> '';

CREATE TABLE video_artifact_reviews (
  id          INTEGER PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES video_artifacts(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  ok          INTEGER NOT NULL,
  comment     TEXT NOT NULL DEFAULT '',
  at          TEXT NOT NULL
);

CREATE INDEX video_artifact_reviews_by_artifact ON video_artifact_reviews(artifact_id, id);
