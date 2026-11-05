-- 0014_storyboard: 分镜和 B-roll 素材（TSK-0456）
--
-- 对照原型 web-next/src/storyboarddata.ts 的 Shot、Broll、MediaRoot。
-- video_shots 是每期视频一份有序的分镜：position 从 1 起连续；text 是对应的口播段落，visual 是画面说明；
-- duration 是手填的时长（秒），NULL 表示按口播字数和语速估（读的时候算，不落库）。
-- video_shot_brolls 是分镜里的 B-roll：只存素材目录 id 加相对路径，不复制、不移动原文件；
-- root_id 是 video_media_roots 的 id，或者 'project'（这一集的视频工程目录，不登记）；kind 是 image / video；
-- in_sec、out_sec 是视频的入点、出点（秒），图片不用。素材目录被删、文件被移走时行留着，读的时候标缺失。
-- video_media_roots 是用户登记的素材目录（绝对路径，全局共用，不按视频分），只读，读要 fs:read:registered。

CREATE TABLE video_shots (
  id         TEXT PRIMARY KEY,
  video_id   TEXT NOT NULL REFERENCES video_videos(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  text       TEXT NOT NULL DEFAULT '',
  visual     TEXT NOT NULL DEFAULT '',
  duration   INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX video_shots_by_video ON video_shots(video_id, position);

CREATE TABLE video_shot_brolls (
  id         TEXT PRIMARY KEY,
  shot_id    TEXT NOT NULL REFERENCES video_shots(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  root_id    TEXT NOT NULL,
  path       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  in_sec     REAL,
  out_sec    REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX video_shot_brolls_by_shot ON video_shot_brolls(shot_id, position);

CREATE TABLE video_media_roots (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
