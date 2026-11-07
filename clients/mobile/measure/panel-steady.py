#!/usr/bin/env python3
"""키보드 ↔ 이모티콘 창을 오가는 동안 입력창(보내기 원)의 세로 자리를 잰다 (#5452).

  python3 measure/panel-steady.py shots <캡처 폴더>            # 네 장 이상의 캡처: 보내기 원의 가운데 y(pt)와 서로의 차이
  python3 measure/panel-steady.py video <녹화.mp4> [--from N]  # 녹화의 프레임마다: 처음 서는 자리와 다른 프레임 수와 최대 이동(pt)

보내기 원은 화면 오른쪽 아래의 채워진 검은 원(`composer-send`, 글자가 있어 채워진 상태)이다. 3배 화면이라 3px = 1pt 이고, 문턱은 1pt 다.
종료 코드는 모든 차이가 문턱 안이면 0, 아니면 1 이다. 표준 라이브러리 + PIL + (녹화는) ffmpeg 만 쓴다.
"""
import argparse
import glob
import os
import subprocess
import sys
import tempfile

from PIL import Image

PX_PER_PT = 3.0
LIMIT_PT = 1.0
# 보내기 원이 서는 가로 띠(1206px 폭 기준)와 세로 탐색 범위. ☺ 단추와 키보드 ↵ 글리프를 비껴 오른쪽 끝에 둔다.
X0, X1 = 1085, 1190
Y0, Y1 = 1100, 2000
DARK = 70  # 밝기 문턱: 채워진 보내기 원은 거의 검다
MIN_RUN, MAX_RUN = 90, 130  # 원의 높이(px)


def circle_center(img):
    """그림의 보내기 원 가운데 y(px). 못 찾으면 None."""
    px = img.convert("L").load()
    w, h = img.size
    x0, x1 = min(X0, w), min(X1, w)
    rows = []
    for y in range(min(Y0, h), min(Y1, h)):
        dark = sum(1 for x in range(x0, x1) if px[x, y] < DARK)
        rows.append(dark >= 40)
    best = None
    run = 0
    for i, on in enumerate(rows + [False]):
        if on:
            run += 1
            continue
        if MIN_RUN <= run <= MAX_RUN:
            start = i - run
            best = (start + i - 1) / 2 + min(Y0, h)
            break
        run = 0
    return best


def shots(folder):
    files = sorted(glob.glob(os.path.join(folder, "**", "*steady-*.png"), recursive=True))
    if len(files) < 2:
        sys.exit("캡처가 둘 이상 필요해요: %s" % folder)
    ys = []
    for path in files:
        y = circle_center(Image.open(path))
        ys.append(y)
        print("%-44s y = %s" % (os.path.basename(path), "없음" if y is None else "%.1f px (%.2f pt)" % (y, y / PX_PER_PT)))
    found = [y for y in ys if y is not None]
    if len(found) != len(ys):
        sys.exit("보내기 원을 못 찾은 캡처가 있어요")
    spread = (max(found) - min(found)) / PX_PER_PT
    print("캡처 %d장, 가장 큰 차이 %.2f pt (문턱 %.1f pt)" % (len(found), spread, LIMIT_PT))
    return 0 if spread <= LIMIT_PT else 1


def video(path, start):
    tmp = tempfile.mkdtemp(prefix="panel-steady-")
    pattern = os.path.join(tmp, "%05d.png")
    # 원이 서는 띠만 잘라 낸다(작은 PNG). 가로 X0-30..X1+30, 세로 Y0..Y1.
    crop = "crop=%d:%d:%d:%d" % (X1 - X0 + 60, Y1 - Y0, X0 - 30, Y0)
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path, "-vf", crop, "-fps_mode", "passthrough", pattern], check=True)
    frames = sorted(glob.glob(os.path.join(tmp, "*.png")))
    ys = []
    for frame in frames:
        img = Image.open(frame)
        # 잘라 낸 그림의 좌표계로 다시 잰다.
        px = img.convert("L").load()
        w, h = img.size
        xs0, xs1 = 30, 30 + (X1 - X0)
        run, best = 0, None
        for y in range(h + 1):
            on = y < h and sum(1 for x in range(xs0, min(xs1, w)) if px[x, y] < DARK) >= 40
            if on:
                run += 1
                continue
            if MIN_RUN <= run <= MAX_RUN and best is None:
                best = (y - run + y - 1) / 2 + Y0
            run = 0
        ys.append(best)
    seen = [(i, y) for i, y in enumerate(ys) if y is not None and i >= start]
    if not seen:
        sys.exit("보내기 원이 보이는 프레임이 없어요")
    # 기준: 원이 처음 서고 나서 가장 흔한 자리(키보드가 올라온 자리).
    first = seen[0][1]
    counts = {}
    for _, y in seen:
        key = round(y / PX_PER_PT, 1)
        counts[key] = counts.get(key, 0) + 1
    ref = max(counts, key=counts.get)
    moved = [(i, y / PX_PER_PT - ref) for i, y in seen if abs(y / PX_PER_PT - ref) > LIMIT_PT]
    worst = max((abs(d) for _, d in moved), default=0.0)
    print("프레임 %d개, 원이 보인 프레임 %d개, 기준 자리 %.1f pt(가장 흔한 자리), 처음 자리 %.1f pt" % (len(ys), len(seen), ref, first / PX_PER_PT))
    print("기준에서 1pt 넘게 벗어난 프레임 %d개, 최대 %.2f pt" % (len(moved), worst))
    for i, d in moved[:12]:
        print("  프레임 %d: %+.2f pt" % (i, d))
    top = sorted(counts.items(), key=lambda kv: -kv[1])[:6]
    print("자리별 프레임 수(pt): " + ", ".join("%.1f×%d" % kv for kv in top))
    return 0 if not moved else 1


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["shots", "video"])
    ap.add_argument("target")
    ap.add_argument("--from", dest="start", type=int, default=0, help="이 프레임부터만 잰다")
    a = ap.parse_args()
    sys.exit(shots(a.target) if a.mode == "shots" else video(a.target, a.start))
