-- 0007_video_topic: 视频记下来自哪个选题（VID-09a）
--
-- 对照原型 web-next/src/videodata.ts 的 Video.topic_id。选题那边的 video_id（0004）同时记着，两边由插件一起写。
-- 选题删掉时清空；一个选题只挂一集视频，同 video_topics_by_video。
-- 0006 以前立项生成的视频这一列是 NULL，由插件第一次读视频时按选题的 video_id 补上（迁移里不能写 UPDATE）。

ALTER TABLE video_videos ADD COLUMN topic_id TEXT REFERENCES video_topics(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX video_videos_by_topic ON video_videos(topic_id) WHERE topic_id IS NOT NULL;
