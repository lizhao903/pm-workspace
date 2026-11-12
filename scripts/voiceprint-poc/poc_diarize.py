# powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import json, os, time
import numpy as np
import librosa
from funasr import AutoModel
from funasr.models.campplus.utils import sv_chunk
from funasr.models.campplus.cluster_backend import ClusterBackend

WAV = "audio/dialog16k.wav"
GT = json.load(open("audio/ground_truth.json"))
OUT = "poc_result.json"

def log(*a):
    print(*a, flush=True)

t0 = time.time()
log("[1/5] 加载 VAD 模型（fsmn-vad，首次会下载）…")
vad = AutoModel(model="fsmn-vad", hub="ms", device="cpu", disable_update=True, disable_pbar=True, log_level="ERROR")
log("    VAD loaded", round(time.time()-t0, 1), "s")

log("[2/5] 加载 CAM++ 声纹模型（首次会下载）…")
spk = AutoModel(model="cam++", hub="ms", device="cpu", disable_update=True, disable_pbar=True, log_level="ERROR")
log("    CAM++ loaded", round(time.time()-t0, 1), "s")

log("[3/5] VAD 分段 + 1.5s 分块…")
res = vad.generate(input=WAV)
vad_segs = res[0]["value"]  # [[start_ms, end_ms]]
audio, sr = librosa.load(WAV, sr=16000, mono=True)
assert sr == 16000
vad_segments = [[s / 1000.0, e / 1000.0, audio[int(s / 1000.0 * sr):int(e / 1000.0 * sr)]] for s, e in vad_segs]
chunks = sv_chunk(vad_segments)
log("    vad segments:", len(vad_segs), "chunks:", len(chunks), round(time.time()-t0, 1), "s")

log("[4/5] 逐块提取 CAM++ 声纹…")
embs = []
for i, (st, ed, data) in enumerate(chunks):
    r = spk.generate(input=data, disable_pbar=True, log_level="ERROR")
    e = r[0]["spk_embedding"].reshape(-1).cpu().numpy()
    embs.append(e)
    if (i + 1) % 20 == 0:
        log("    embedded", i + 1, "/", len(chunks))
X = np.stack(embs)
log("    embedding matrix:", X.shape, "dim", round(time.time()-t0, 1), "s")

log("[5/5] 聚类（谱聚类/HDBSCAN，max 4 人）+ 与真值对齐…")
cb = ClusterBackend(max_num_spks=4)
labels = cb.forward(X)
uniq = sorted(set(int(l) for l in labels))
log("    clusters:", uniq)

# 每块的起止秒
intervals = [(c[0], c[1]) for c in chunks]

def gt_speaker(st, ed):
    best, best_ov = "?", 0.0
    for g in GT:
        ov = max(0.0, min(ed * 1000, g["end_ms"]) - max(st * 1000, g["start_ms"]))
        if ov > best_ov:
            best_ov, best = ov, g["speaker"]
    return best

gt = [gt_speaker(st, ed) for st, ed in intervals]
log("    chunk GT speakers:", "".join(gt))

# 帧级准确率：把聚类簇映射到多数真值说话人
from collections import Counter
label2gt = {}
for lab in uniq:
    c = Counter(g for l, g in zip(labels, gt) if int(l) == lab)
    label2gt[lab] = c.most_common(1)[0][0] if c else "?"
pred = [label2gt[int(l)] for l in labels]
correct = sum(1 for p, g in zip(pred, gt) if p == g)
dur_correct = 0.0; dur_total = 0.0
for (st, ed), p, g in zip(intervals, pred, gt):
    d = max(0.0, ed - st)
    dur_total += d
    if p == g:
        dur_correct += d
log("    label->speaker:", label2gt)
log("    chunk accuracy: %d/%d = %.1f%%" % (correct, len(gt), 100 * correct / len(gt)))
log("    duration-weighted accuracy: %.1f%%" % (100 * dur_correct / dur_total if dur_total else 0))
log("    speaker count: pred=%d gt=%d" % (len(uniq), 2))

# 声纹注册匹配：单独录的注册音频 embedding 与各簇质心余弦相似度
def embed_file(path):
    r = spk.generate(input=path, disable_pbar=True, log_level="ERROR")
    return r[0]["spk_embedding"].reshape(-1).cpu().numpy()

enroll = {"A": embed_file("audio/enrollA.wav"), "B": embed_file("audio/enrollB.wav")}
centers = {}
for lab in uniq:
    centers[lab] = X[labels == lab].mean(axis=0)

def cos(a, b):
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))

sim = {}
for name, e in enroll.items():
    sim[name] = {lab: round(cos(e, c), 4) for lab, c in centers.items()}
log("    注册声纹与簇质心余弦相似度:", json.dumps(sim, ensure_ascii=False))
ok = 0
for name, e in enroll.items():
    best_lab = max(sim[name], key=sim[name].get)
    # 该簇的多数真值等于该注册人就算匹配成功
    ok += 1 if label2gt[best_lab] == name else 0
log("    enrollment match: %d/2" % ok)

json.dump({
    "vad_segments": vad_segs,
    "chunks": [{"start": round(st, 3), "end": round(ed, 3), "label": int(l), "gt": g, "pred": p}
               for (st, ed), l, g, p in zip(intervals, labels, gt, pred)],
    "label2gt": label2gt,
    "chunk_accuracy": correct / len(gt),
    "duration_accuracy": dur_correct / dur_total if dur_total else 0,
    "speaker_count": len(uniq),
    "enroll_similarity": sim,
    "enroll_match": ok,
    "elapsed_s": round(time.time() - t0, 1),
}, open(OUT, "w"), ensure_ascii=False, indent=2)
log("DONE", round(time.time() - t0, 1), "s ->", OUT)
