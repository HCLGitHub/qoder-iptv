"""生成 MP2 解码测试用的片段（开发时跑一次，产物已提交，跑单测不需要 Python）。

  python scripts/fixtures/mp2/gen.py

依赖 PyAV（pip install av numpy），编码/参考解码都走它自带的 ffmpeg。
  sine-stereo-48k-192k.mp2  左 440Hz / 右 660Hz，看音调、音量、声道没串
  sine-mono-48k-64k.mp2     单声道
  noise-stereo-48k-64k.mp2  宽带噪声，低码率逼出粗量化器（3/5/9 级）
  noise-stereo-48k-64k.ref.f32  ffmpeg 解出的第 12 帧，左右声道各 1152 个 float32 依次排
"""
import os
import numpy as np
import av

DIR = os.path.dirname(os.path.abspath(__file__))
SR = 48000
N = int(SR * 0.6)
FRAME = 1152
REF_FRAME = 12
t = np.arange(N) / SR


def encode(name, bitrate, layout, data):
    c = av.open(os.path.join(DIR, name), 'w', format='mp2')
    s = c.add_stream('mp2', rate=SR)
    s.bit_rate = bitrate
    s.layout = layout
    pcm = (np.clip(data, -1, 1) * 32767).astype(np.int16)
    for i in range(0, N, FRAME):
        chunk = pcm[:, i:i + FRAME]
        chunk = np.pad(chunk, ((0, 0), (0, FRAME - chunk.shape[1])))
        f = av.AudioFrame.from_ndarray(np.ascontiguousarray(chunk.T.reshape(1, -1)), format='s16', layout=layout)
        f.sample_rate = SR
        f.pts = i
        for p in s.encode(f):
            c.mux(p)
    for p in s.encode(None):
        c.mux(p)
    c.close()


def decode(name):
    c = av.open(os.path.join(DIR, name))
    parts = []
    for f in c.decode(audio=0):
        a = f.to_ndarray().astype(np.float32)
        if f.format.name.startswith('s16'):
            a /= 32768.0
        if not f.format.is_planar:
            a = a.reshape(f.samples, -1).T
        parts.append(a)
    c.close()
    return np.concatenate(parts, axis=1)


encode('sine-stereo-48k-192k.mp2', 192000, 'stereo', np.stack([0.5 * np.sin(2 * np.pi * 440 * t), 0.3 * np.sin(2 * np.pi * 660 * t)]))
encode('sine-mono-48k-64k.mp2', 64000, 'mono', np.stack([0.5 * np.sin(2 * np.pi * 440 * t)]))

rng = np.random.default_rng(1)
noise = rng.standard_normal((2, N)) * 0.15
for k in range(1, 40):
    noise[0] += 0.02 * np.sin(2 * np.pi * 150 * k * t + rng.uniform(0, 6.28))
    noise[1] += 0.02 * np.sin(2 * np.pi * (150 * k + 37) * t + rng.uniform(0, 6.28))
encode('noise-stereo-48k-64k.mp2', 64000, 'stereo', noise)
ref = decode('noise-stereo-48k-64k.mp2')[:, REF_FRAME * FRAME:(REF_FRAME + 1) * FRAME]
ref.astype('<f4').tofile(os.path.join(DIR, 'noise-stereo-48k-64k.ref.f32'))
print('ok', ref.shape)
