-- 0003_artifact_ratio: 产出物对齐 web-video-presentation 技能（VID-02a）
--
-- 对照原型 web-next/src/videodata.ts 的 Artifact.ratio、Artifact.lang、CoverRatio。
-- ratio 是封面本身的比例（16x9 / 4x3 / 9x16 / 3x4 / 1x1），和舞台方向 variant 分开，只有封面有，别的类型存空串。
-- lang 是字幕语言，只有字幕有，别的类型存空串。
-- 封面的方案序号和选用改按「视频 + 方向 + 封面比例」分组：竖屏可以同时有 9:16、3:4、1:1 各自的第 1 个方案和各自选用的一张。
-- 0002 的两个唯一索引只按方向分组，插件迁移不能删索引，所以序号和选用换到新列 cover_option、cover_picked，
-- 旧列 option_no、picked 不再写（新行是 NULL 和 0）。0002 时登记的封面由插件第一次处理产出物时搬过来：
-- ratio 按方向取默认比例，序号和选用挪到新列（迁移里不能写 UPDATE）。

ALTER TABLE video_artifacts ADD COLUMN ratio TEXT NOT NULL DEFAULT '';

ALTER TABLE video_artifacts ADD COLUMN lang TEXT NOT NULL DEFAULT '';

ALTER TABLE video_artifacts ADD COLUMN cover_option INTEGER;

ALTER TABLE video_artifacts ADD COLUMN cover_picked INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX video_artifacts_cover_option ON video_artifacts(video_id, variant, ratio, cover_option) WHERE cover_option IS NOT NULL;

CREATE UNIQUE INDEX video_artifacts_cover_picked ON video_artifacts(video_id, variant, ratio) WHERE cover_picked = 1;
