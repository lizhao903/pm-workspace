#!/usr/bin/env python3
# powered by dsh - https://github.com/deepseek-ai/deepseek-harness

"""录音插件 M5 声纹 sidecar：VAD + CAM++ 分块 + 谱聚类，给 Go 侧返回说话人分段与质心。

移植自 scripts/voiceprint-poc/poc_diarize.py（方案 A），协议见
docs/recording-transcription-design.md §14.3。插件用 go:embed 内嵌本脚本，运行时写到
CacheDir()/recording/voiceprint.py 再按设置里的 Python 路径启动。

只用标准库 + numpy + funasr；识别阶段不联网（模型首次由 FunASR/ModelScope 下载到缓存）。
输出只写到 --out 指定的文件，不碰用户数据目录之外的东西。

退出码：0 成功；3 缺依赖（stderr 有中文提示）；其它为失败。
"""

import argparse
import base64
import json
import os
import sys
import wave

# 和 Go 侧约定的模型名/维度（campplus_cn_common 是 192 维）。
MODEL_NAME = "campplus_cn_common"
EXPECTED_DIM = 192
# VAD 切出的语音段按 1.5s 窗口 / 0.75s 步长分块（funasr 的 sv_chunk 默认参数）。
SAMPLE_RATE = 16000


def log(msg):
    """进度/错误都走 stderr，stdout 留给调用方可选解析。"""
    print(msg, file=sys.stderr, flush=True)


def parse_args():
    p = argparse.ArgumentParser(description="录音插件说话人分离 sidecar（内部协议）")
    p.add_argument("--input", required=True, help="16k 单声道 16 位 wav")
    p.add_argument("--out", required=True, help="输出的 JSON 路径")
    p.add_argument("--model-dir", default="", help="FunASR/ModelScope 模型缓存目录（空=默认缓存）")
    p.add_argument("--max-speakers", type=int, default=8, help="最多识别几个说话人（1–16）")
    return p.parse_args()


def clamp_speakers(n):
    if n < 1:
        return 1
    if n > 16:
        return 16
    return n


def read_wav_16k_mono(path):
    """读 16k 单声道 16 位 wav 成 [-1,1] 的 float32 数组；Go 侧用 ffmpeg 保证格式。"""
    import numpy as np

    with wave.open(path, "rb") as wf:
        channels = wf.getnchannels()
        rate = wf.getframerate()
        width = wf.getsampwidth()
        if channels != 1 or rate != SAMPLE_RATE or width != 2:
            log("输入音频格式不对：需要 16k 单声道 16 位 wav（实际 %d Hz / %d 声道 / %d 字节）" % (rate, channels, width))
            return None
        raw = wf.readframes(wf.getnframes())
    audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if audio.size == 0:
        log("输入音频是空的")
        return None
    return audio


def merge_segments(intervals):
    """把同一说话人的分块区间合并成连续段（相邻/重叠取并集），毫秒整数。"""
    if not intervals:
        return []
    spans = sorted((int(round(s * 1000)), int(round(e * 1000))) for s, e in intervals)
    merged = [list(spans[0])]
    for start, end in spans[1:]:
        if start <= merged[-1][1]:
            if end > merged[-1][1]:
                merged[-1][1] = end
        else:
            merged.append([start, end])
    return merged


def write_output(path, speakers, dim):
    """原子写 JSON：先写 .tmp 再替换，避免 Go 侧读到半个文件。"""
    payload = {"model": MODEL_NAME, "dim": int(dim), "speakers": speakers}
    directory = os.path.dirname(os.path.abspath(path))
    if directory:
        os.makedirs(directory, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def run_diarize(args):
    # funasr 依赖较晚导入：缺依赖时给出中文提示 + 退出码 3，让插件把原因写进 job.last_error。
    try:
        import numpy as np
        from funasr import AutoModel
        from funasr.models.campplus.utils import sv_chunk
        from funasr.models.campplus.cluster_backend import ClusterBackend
    except ImportError as e:
        log("缺少 Python 依赖 funasr：请先执行 pip install funasr（以及 numpy）。原始错误：%s" % e)
        sys.exit(3)
    except Exception as e:  # noqa: BLE001 - funasr 初始化失败也按缺依赖处理，原因原样带回去
        log("加载 funasr 失败（可能需要 pip install funasr 并确认能 import torch）：%s" % e)
        sys.exit(3)

    max_spks = clamp_speakers(args.max_speakers)
    if not os.path.isfile(args.input):
        log("输入音频不存在：%s" % args.input)
        return 1
    audio = read_wav_16k_mono(args.input)
    if audio is None:
        return 1

    log("[1/5] 加载 VAD 模型（fsmn-vad，首次会下载到模型缓存）…")
    vad = AutoModel(model="fsmn-vad", hub="ms", device="cpu", disable_update=True, disable_pbar=True, log_level="ERROR")
    log("[2/5] 加载 CAM++ 声纹模型（首次会下载到模型缓存）…")
    spk = AutoModel(model="cam++", hub="ms", device="cpu", disable_update=True, disable_pbar=True, log_level="ERROR")

    log("[3/5] VAD 分段 + 1.5s 分块…")
    res = vad.generate(input=args.input)
    vad_segs = res[0]["value"] if res else []
    vad_segments = [
        [s / 1000.0, e / 1000.0, audio[int(s / 1000.0 * SAMPLE_RATE):int(e / 1000.0 * SAMPLE_RATE)]]
        for s, e in vad_segs
    ]
    chunks = sv_chunk(vad_segments)
    if not chunks:
        log("没检测到语音，输出 0 个说话人")
        write_output(args.out, [], EXPECTED_DIM)
        return 0

    log("[4/5] 逐块提取 CAM++ 声纹（%d 块）…" % len(chunks))
    embs = []
    for _, (_st, _ed, data) in enumerate(chunks):
        r = spk.generate(input=data, disable_pbar=True, log_level="ERROR")
        embs.append(r[0]["spk_embedding"].reshape(-1).cpu().numpy())
    x = np.stack(embs)
    dim = int(x.shape[1])

    log("[5/5] 谱聚类（最多 %d 人）…" % max_spks)
    labels = np.asarray(ClusterBackend(max_num_spks=max_spks).forward(x)).astype(int).reshape(-1)

    # 按块顺序记每个簇的区间，簇按首次出现顺序编号 spk_1、spk_2…
    order = []
    intervals = {}
    for idx, raw_label in enumerate(labels):
        label = int(raw_label)
        if label not in intervals:
            order.append(label)
            intervals[label] = []
        st, ed, _data = chunks[idx]
        intervals[label].append((float(st), float(ed)))

    speakers = []
    for n, label in enumerate(order, start=1):
        centroid = x[labels == label].mean(axis=0).astype(np.float32)
        speakers.append({
            "label": "spk_%d" % n,
            "embedding": base64.b64encode(centroid.tobytes()).decode("ascii"),
            "segments": merge_segments(intervals[label]),
        })
    write_output(args.out, speakers, dim)
    log("完成：%d 个说话人，维度 %d，输出 %s" % (len(speakers), dim, args.out))
    return 0


def main():
    args = parse_args()
    # 在 import funasr/modelscope 之前设置缓存目录，让模型下载/加载走用户指定的目录。
    if args.model_dir:
        os.environ["MODELSCOPE_CACHE"] = args.model_dir
    return run_diarize(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 - 任何异常都转成中文 stderr + 非零退出码
        log("说话人识别失败：%s" % e)
        sys.exit(1)
