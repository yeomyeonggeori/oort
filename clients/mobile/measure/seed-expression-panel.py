#!/usr/bin/env python3
"""이모티콘 창(키보드 자리) 확인용 시드 (#5452): 세트가 있는 이모티콘·GIF·작은 이모지를 팀 보관함에 등록하고 대화 하나를 만든다.

  python3 measure/seed-expression-panel.py --api http://127.0.0.1:<api 포트> --pg <postgres 컨테이너 이름> [--out state.json] [--empty]

하는 일:
  1. 사람 멤버 둘(나 = admin, 상대 = member)을 SQL 로 만든다(비밀번호는 실행마다 무작위, `--out` 파일에만 적고 0600).
  2. 합성 그림(PIL, 외부 자산 없음)을 만들어 팀 표현으로 등록한다: 세트 앞머리(`dam_`·`chi_`·`cou_`)를 가진 정지 이모티콘, 낱개 둘, 세트 둘 + 낱개의 GIF, 작은 이모지 셋.
     `--empty` 면 등록하지 않는다(빈 보관함 상태 확인용).
  3. 공개 채널 하나를 만들고 상대를 넣고 글 몇 줄을 보낸다. 내 읽음 커서를 끝으로 옮긴다.
표준 라이브러리 + PIL + `docker exec <postgres 컨테이너> psql` 만 쓴다. 외부 네트워크로 나가지 않는다.
"""
import argparse
import hashlib
import json
import os
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

WS = "00000000-0000-7000-8000-000000000001"
ap = argparse.ArgumentParser()
ap.add_argument("--api", default="http://127.0.0.1:24550")
ap.add_argument("--pg", default="momo_5452-postgres-1")
ap.add_argument("--out", default="")
ap.add_argument("--empty", action="store_true", help="표현을 등록하지 않는다")
ap.add_argument("--name", default="panel-lab")
args = ap.parse_args()
API = args.api.rstrip("/")
RUN = secrets.token_hex(4)
ME_EMAIL, ME_PW = f"panel-me-{RUN}@momo.local", secrets.token_hex(12)
PEER_EMAIL, PEER_PW = f"panel-peer-{RUN}@momo.local", secrets.token_hex(12)
MEDIA = os.path.join(tempfile.gettempdir(), f"panel-lab-media-{RUN}")


def sql(text, tuples=False):
    cmd = ["docker", "exec", "-i", args.pg, "psql", "-U", "momo", "-d", "momo", "-v", "ON_ERROR_STOP=1", "--no-psqlrc", "-q"]
    if tuples:
        cmd += ["-tA"]
    out = subprocess.run(cmd, input=text.encode(), capture_output=True)
    if out.returncode != 0:
        raise SystemExit("psql 실패: " + out.stderr.decode()[:600])
    return out.stdout.decode().strip()


def call(method, path, token=None, body=None, raw=None, ctype="application/json", expect=(200, 201, 204)):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    for _ in range(6):
        req = urllib.request.Request(API + path, data=data, method=method)
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", ctype)
        if token:
            req.add_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                text, status = resp.read(), resp.status
        except urllib.error.HTTPError as err:
            text, status = err.read(), err.code
            if status == 429:
                time.sleep(min(max(int(err.headers.get("Retry-After", "5") or 5), 2), 30))
                continue
        try:
            payload = json.loads(text) if text else {}
        except ValueError:
            payload = {"raw": text[:200].decode(errors="replace")}
        if status not in expect:
            raise SystemExit(f"{method} {path} -> {status}: {json.dumps(payload, ensure_ascii=False)[:300]}")
        return status, payload
    raise SystemExit(f"{method} {path}: 429 가 계속돼요")


def multipart(metadata, path, mime):
    boundary = "oort" + uuid.uuid4().hex
    blob = open(path, "rb").read()
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"; filename="metadata.json"\r\nContent-Type: application/json\r\n\r\n'.encode()
        + json.dumps(metadata, ensure_ascii=False).encode()
        + b"\r\n",
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{os.path.basename(path)}"\r\nContent-Type: {mime}\r\n\r\n'.encode()
        + blob
        + b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


# ---- 합성 그림 ---------------------------------------------------------------------------------
FONT = "/System/Library/Fonts/AppleSDGothicNeo.ttc"
PALETTE = [(255, 205, 90, 255), (255, 170, 150, 255), (170, 200, 255, 255), (190, 235, 160, 255), (230, 190, 255, 255), (255, 190, 120, 255)]
MOODS = ["smile", "open", "sleepy"]


def make_items():
    from PIL import Image, ImageDraw, ImageFont

    os.makedirs(MEDIA, exist_ok=True)

    def font(size):
        try:
            return ImageFont.truetype(FONT, size)
        except Exception:
            return ImageFont.load_default()

    def face(size, base, label=None, mood="smile", shift=0):
        s = size
        img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        pad = int(s * 0.08)
        d.ellipse([pad, pad + shift, s - pad, s - pad + shift], fill=base, outline=(60, 50, 40, 255), width=max(2, s // 60))
        eye_y = int(s * 0.42) + shift
        ew = max(3, s // 22)
        for ex in (int(s * 0.34), int(s * 0.66)):
            d.ellipse([ex - ew, eye_y - ew * 1.6, ex + ew, eye_y + ew * 1.6], fill=(50, 40, 30, 255))
        my = int(s * 0.62) + shift
        if mood == "smile":
            d.arc([int(s * 0.3), my - int(s * 0.1), int(s * 0.7), my + int(s * 0.16)], 10, 170, fill=(50, 40, 30, 255), width=max(3, s // 36))
        elif mood == "open":
            d.ellipse([int(s * 0.4), my - 2, int(s * 0.6), my + int(s * 0.16)], fill=(120, 40, 40, 255))
        else:
            d.line([int(s * 0.38), my + 4, int(s * 0.62), my + 4], fill=(50, 40, 30, 255), width=max(3, s // 36))
        if label:
            f = font(int(s * 0.17))
            bbox = d.textbbox((0, 0), label, font=f)
            w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
            x0, y0 = (s - w) // 2, int(s * 0.80)
            d.rounded_rectangle([x0 - 10, y0 - 6, x0 + w + 10, y0 + h + 12], radius=12, fill=(255, 255, 255, 235), outline=(60, 50, 40, 255), width=2)
            d.text((x0, y0), label, font=f, fill=(40, 30, 20, 255))
        return img

    items = []

    def add(key, display, kind, tags, path, mime):
        items.append({"key": key, "display": display, "kind": kind, "tags": tags, "path": path, "mime": mime})

    def still(key, display, tags, i, label=None):
        path = f"{MEDIA}/{key}.png"
        face(240, PALETTE[i % 6], label or display, MOODS[i % 3]).save(path, "PNG")
        add(key, display, "sticker", tags, path, "image/png")

    def moving(key, display, tags, i):
        c = PALETTE[i % 6]
        frames = [face(240, c, display, "open"), face(240, c, display, "smile", shift=-8), face(240, c, display, "sleepy", shift=6)]
        path = f"{MEDIA}/{key}.gif"
        frames[0].save(path, save_all=True, append_images=frames[1:], duration=220, loop=0, disposal=2, transparency=0)
        add(key, display, "sticker", tags, path, "image/gif")

    def tiny(key, display, tags, i):
        path = f"{MEDIA}/{key}.png"
        face(64, PALETTE[i % 6], None, MOODS[i % 3]).save(path, "PNG")
        add(key, display, "emoji", tags, path, "image/png")

    for i, (k, d) in enumerate([("kk", "킹받네"), ("haa", "하"), ("peace", "평화"), ("leave", "퇴근"), ("ok", "좋아요"), ("sorry", "미안")]):
        still(f"dam_{k}", d, ["농담곰", d], i)
    for i, (k, d) in enumerate([("yay", "야호"), ("sleep", "쿨쿨"), ("thx", "땡큐"), ("cry", "엉엉"), ("run", "달려")]):
        still(f"chi_{k}", d, ["치이카와", d], i + 1)
    for i, (k, d) in enumerate([("deploy", "배포"), ("wow", "대박"), ("bye", "안녕")]):
        still(f"cou_{k}", d, ["커리지", d], i + 2)
    still("cheers_still", "건배", ["축하"], 0, "건배!")
    still("sleepy_still", "졸려요", ["피곤"], 2, "졸려요")
    for i, (k, d) in enumerate([("dance", "춤춰요"), ("jump", "점프"), ("clap", "박수")]):
        moving(f"nya_{k}", d, ["냥코센세", d], i)
    for i, (k, d) in enumerate([("spin", "빙글"), ("wave", "안녕")]):
        moving(f"usa_{k}", d, ["우사기", d], i + 3)
    moving("ki_jeol", "기절", ["놀람"], 1)
    moving("thumbs_up", "엄지척", ["좋아요"], 5)
    tiny("party_parrot", "파티 앵무새", ["축하"], 3)
    tiny("smile_tiny", "작은 웃음", ["웃음"], 0)
    tiny("wow_tiny", "깜짝", ["놀람"], 4)
    return items


def ensure_members():
    ids = {}
    for key, email, pw, name, handle, role in (
        ("me", ME_EMAIL, ME_PW, "Seed Me", f"panel-me-{RUN}", "admin"),
        ("peer", PEER_EMAIL, PEER_PW, "Seed Peer", f"panel-peer-{RUN}", "member"),
    ):
        mid = str(uuid.uuid4())
        sql(
            f"""BEGIN;
SET LOCAL app.workspace_id = '{WS}';
SET LOCAL row_security = off;
INSERT INTO member (id, workspace_id, kind, status, display_name, handle) VALUES ('{mid}', '{WS}', 'human', 'active', '{name}', '{handle}');
INSERT INTO human (member_id, workspace_id, email, email_verified, password_hash, tz) VALUES ('{mid}', '{WS}', '{email}', true, momo_password_hash('{pw}'), 'UTC');
INSERT INTO workspace_membership (workspace_id, member_id, role) VALUES ('{WS}', '{mid}', '{role}');
COMMIT;"""
        )
        ids[key] = mid
    return ids


def login(email, pw):
    _, body = call("POST", "/v1/auth/login", body={"email": email, "password": pw})
    return body["accessToken"]


def register(me, item):
    body, ctype = multipart({"name": item["key"], "displayName": item["display"], "tags": item["tags"], "subjectMemberId": None}, item["path"], item["mime"])
    _, draft = call("POST", f"/v1/workspaces/{WS}/expressions/uploads", me, raw=body, ctype=ctype)
    if draft.get("state") != "ready":
        raise SystemExit(f"{item['key']}: 초안이 ready 가 아니에요: {json.dumps(draft)[:300]}")
    choice = {"draftId": draft["draftId"], "revision": draft["revision"], "sha256": draft["media"]["large"]["sha256"], "kind": item["kind"]}
    call("POST", f"/v1/workspaces/{WS}/expressions", me, body=choice)


def send(token, channel, body):
    _, msg = call("POST", f"/v1/workspaces/{WS}/channels/{channel}/messages", token, body={"body": body, "clientMsgId": str(uuid.uuid4())})
    return (msg.get("message") or msg)["id"]


LINES = [
    ("peer", "오늘 배포 끝났어요!"),
    ("me", "고생 많으셨어요."),
    ("peer", "다음 주 일정은 내일 아침에 정리해서 올릴게요."),
    ("me", "좋아요, 기다릴게요."),
    ("peer", "점심은 뭐 드실래요?"),
]


def main():
    ids = ensure_members()
    me, peer = login(ME_EMAIL, ME_PW), login(PEER_EMAIL, PEER_PW)
    registered = 0
    if not args.empty:
        for item in make_items():
            register(me, item)
            registered += 1
    suffix = time.strftime("%H%M%S")
    name = f"{args.name}-{suffix}"
    _, ch = call("POST", f"/v1/workspaces/{WS}/channels", me, body={"kind": "public", "name": name})
    channel = (ch.get("channel") or ch)["id"]
    sql(f"""BEGIN;
SET LOCAL app.workspace_id = '{WS}';
SET LOCAL row_security = off;
INSERT INTO membership (workspace_id, channel_id, member_id, role) VALUES ('{WS}', '{channel}', '{ids['peer']}', 'member') ON CONFLICT DO NOTHING;
COMMIT;""")
    for who, text in LINES:
        send(me if who == "me" else peer, channel, text)
        time.sleep(0.05)
    call("PUT", f"/v1/workspaces/{WS}/channels/{channel}/read-state", me, body={"last_read_seq": 1000000, "read_intent": "explicit_open"})
    state = {
        "api": API, "workspace": WS, "channel": channel, "channelName": name, "registered": registered,
        "me": {"email": ME_EMAIL, "password": ME_PW, "id": ids["me"]},
        "peer": {"email": PEER_EMAIL, "password": PEER_PW, "id": ids["peer"]},
    }
    text = json.dumps(state, indent=2, ensure_ascii=False)
    if args.out:
        with open(args.out, "w") as fh:
            fh.write(text)
        os.chmod(args.out, 0o600)  # 계정 비밀번호가 들어 있다
        print("state ->", args.out, f"(등록 {registered}개)", file=sys.stderr)
    else:
        print(text)


if __name__ == "__main__":
    main()
