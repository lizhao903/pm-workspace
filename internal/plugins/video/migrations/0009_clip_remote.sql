-- 0009_clip_remote: 评论收件（VID-08b）
--
-- 后台任务按发布记录从平台拉评论，落成评论素材（kind comment，带 publish_id）。
-- remote_id 是「平台:平台评论 id」，同一条评论拉多少次只落一份，唯一索引兜底；手动收的素材存空串，不参与去重。
-- 只在插件内部用，不出现在接口的 VideoClip 里。

ALTER TABLE video_clips ADD COLUMN remote_id TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX video_clips_by_remote ON video_clips(remote_id) WHERE remote_id <> '';
