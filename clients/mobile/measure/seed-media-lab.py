#!/usr/bin/env python3
"""큰 이모티콘·움직이는 이모티콘·이미지·GIF 첨부·링크 카드·이모티콘 반응이 섞인 대화를 레인 서버에 만든다 (#5451).

`measure/run-media-entry.sh` 의 시드다. 표준 라이브러리 + ffmpeg(그림 만들기) + `docker exec <postgres 컨테이너> psql` 만 쓴다.

  python3 measure/seed-media-lab.py --api http://127.0.0.1:<api 포트> --pg <postgres 컨테이너 이름> --profile entry|taps [--out state.json]

하는 일:
  1. 사람 멤버 둘(나 = admin, 상대 = member)을 SQL 로 만든다(레인 픽스처와 같은 방식, 비밀번호는 실행마다 무작위). 이미 있으면 재사용하지 않고 새로 만든다.
  2. 채널을 만들고 상대를 넣는다. 작성자를 번갈아 써서 모든 글에 아바타가 선다(행을 아바타로 찾는다).
  3. 팀 표현을 등록한다: 큰 정지(512px PNG) · 넓은 정지(512x256) · 작은(64px) · 움직이는 GIF(2초·5초).
  4. 글·표현·이미지/GIF 첨부·링크(외부 접속 없이 `message_unfurl` 행을 직접 심는다)·반응을 오래된 것부터 보낸다. 마지막에 내 읽음 커서를 끝으로 옮긴다.
결과(채널 id·계정)는 --out(기본: 표준출력)에 JSON 으로 적는다. 프로필: `entry` = 한 화면을 넘고 맨 아래에 모든 종류가 섞인 채널, `taps` = 맨 아래에 정지 큰 이모티콘 하나·움직이는 것(5초) 하나.
레인에는 첨부를 담을 자리가 있어야 한다: `LANE_PHONE_LOCAL_DRIVE=1`(ADR-0169 로컬 볼륨). 외부 네트워크로 나가지 않는다.

사진·GIF 첨부는 올린 뒤 보내기 전에 **가로세로를 선언한다**(`PUT …/attachments/{id}/media {kind: image, width, height}`, ADR-0151 증보 9, #5469) —
새 앱이 올린 사진과 같다. 처음 보는 사진이 대화에 들어갈 때 첫 프레임부터 제 칸에 서는지(행 이동 ≤1pt)는 이 선언이 있어야 잰다.
`--no-declare-sizes` 는 선언 없이 올린다(옛 앱이 보낸 사진·옛 메시지 흉내): 처음 보는 사진이 한 번 자라는 **기준선**이고, 한 번 본 뒤에는 0 이다.
선언은 덤이라 서버가 거절해도(옛 서버 422 등) 시드는 계속한다.
"""
import argparse
import hashlib
import json
import os
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import tempfile
MEDIA = os.path.join(tempfile.gettempdir(), "media-lab-assets")
WS = "00000000-0000-7000-8000-000000000001"

ap = argparse.ArgumentParser()
ap.add_argument("--api", default="http://127.0.0.1:24510")
ap.add_argument("--pg", default="momo_5451-postgres-1")
ap.add_argument("--name", default="media-lab")
ap.add_argument("--out", default="")
ap.add_argument("--fillers", type=int, default=18)
ap.add_argument("--profile", default="entry,taps", help="entry, taps 또는 둘(쉼표)")
ap.add_argument("--no-declare-sizes", action="store_true", help="사진·GIF 의 가로세로를 선언하지 않고 올린다(옛 앱·옛 메시지 흉내, 기준선)")
args = ap.parse_args()
API = args.api.rstrip("/")
PG = args.pg

import secrets
RUN = secrets.token_hex(4)
ME_EMAIL, ME_PW = f"media-me-{RUN}@momo.local", secrets.token_hex(12)
PEER_EMAIL, PEER_PW = f"media-peer-{RUN}@momo.local", secrets.token_hex(12)


def sh(cmd, **kw):
    return subprocess.run(cmd, check=True, **kw)


def sql(text, tuples=False):
    cmd = ["docker", "exec", "-i", PG, "psql", "-U", "momo", "-d", "momo", "-v", "ON_ERROR_STOP=1", "--no-psqlrc", "-q"]
    if tuples:
        cmd += ["-tA"]
    out = subprocess.run(cmd, input=text.encode(), capture_output=True)
    if out.returncode != 0:
        raise SystemExit("psql 실패: " + out.stderr.decode()[:600])
    return out.stdout.decode().strip()


def call(method, path, token=None, body=None, raw=None, ctype="application/json", expect=(200, 201, 204), retry=True):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    for attempt in range(6):
        req = urllib.request.Request(API + path if path.startswith("/") else path, data=data, method=method)
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", ctype)
        if token:
            req.add_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                text = resp.read()
                status = resp.status
        except urllib.error.HTTPError as err:
            text = err.read()
            status = err.code
            if status == 429 and retry:
                wait = int(err.headers.get("Retry-After", "5") or 5)
                time.sleep(min(max(wait, 2), 30))
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


def ffmpeg(*a):
    sh(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *a])


def make_media():
    os.makedirs(MEDIA, exist_ok=True)
    m = lambda n: os.path.join(MEDIA, n)
    if not os.path.exists(m("big.png")):
        ffmpeg("-f", "lavfi", "-i", "gradients=s=512x512:c0=0xff6b6b:c1=0x4ecdc4:n=2", "-frames:v", "1", m("big.png"))
    if not os.path.exists(m("wide.png")):
        ffmpeg("-f", "lavfi", "-i", "gradients=s=512x256:c0=0xffd166:c1=0x118ab2:n=3", "-frames:v", "1", m("wide.png"))
    if not os.path.exists(m("tiny.png")):
        ffmpeg("-f", "lavfi", "-i", "gradients=s=64x64:c0=0xef476f:c1=0xffd166:n=2", "-frames:v", "1", m("tiny.png"))
    if not os.path.exists(m("groove.gif")):
        ffmpeg("-f", "lavfi", "-i", "testsrc2=s=360x360:r=10:d=2", "-vf", "format=rgb24,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse", m("groove.gif"))
    if not os.path.exists(m("slow.gif")):
        # 5초짜리 움직이는 그림 — 총 4회 돌면 20초라 누르기 시험 창(수 초) 안에서 정지로 바뀌지 않는다.
        ffmpeg("-f", "lavfi", "-i", "testsrc2=s=360x360:r=6:d=5", "-vf", "format=rgb24,split[a][b];[a]palettegen=max_colors=48[p];[b][p]paletteuse", m("slow.gif"))
    if not os.path.exists(m("photo-land.jpg")):
        ffmpeg("-f", "lavfi", "-i", "gradients=s=1200x800:c0=0x264653:c1=0xe9c46a:n=4:speed=0.02", "-frames:v", "1", "-q:v", "4", m("photo-land.jpg"))
    if not os.path.exists(m("photo-port.png")):
        ffmpeg("-f", "lavfi", "-i", "gradients=s=600x900:c0=0x2a9d8f:c1=0xe76f51:n=3:speed=0.02", "-frames:v", "1", m("photo-port.png"))
    if not os.path.exists(m("anim.gif")):
        ffmpeg("-f", "lavfi", "-i", "testsrc2=s=320x240:r=8:d=2", "-vf", "format=rgb24,split[a][b];[a]palettegen=max_colors=48[p];[b][p]paletteuse", m("anim.gif"))


def ensure_members():
    ids = {}
    for key, email, pw, name, handle, role in (
        ("me", ME_EMAIL, ME_PW, "Seed Me", f"media-me-{RUN}", "admin"),
        ("peer", PEER_EMAIL, PEER_PW, "Seed Peer", f"media-peer-{RUN}", "member"),
    ):
        got = sql(f"SELECT m.id FROM member m JOIN human h ON h.member_id = m.id WHERE h.email = '{email}';", tuples=True)
        if got:
            ids[key] = got.splitlines()[0]
            continue
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


def register(me, name, display, filename, mime, kind):
    _, listing = call("GET", f"/v1/workspaces/{WS}/expressions", me)
    existing = {row.get("name"): row for row in (listing.get("expressions") or listing.get("items") or [])}
    if name in existing:
        return existing[name]["id"]
    body, ctype = multipart({"name": name, "displayName": display, "tags": [display], "subjectMemberId": None}, os.path.join(MEDIA, filename), mime)
    _, draft = call("POST", f"/v1/workspaces/{WS}/expressions/uploads", me, raw=body, ctype=ctype)
    if draft.get("state") != "ready":
        raise SystemExit(f"{name}: 초안이 ready 가 아니에요: {json.dumps(draft)[:300]}")
    choice = {"draftId": draft["draftId"], "revision": draft["revision"], "sha256": draft["media"]["large"]["sha256"], "kind": kind}
    _, result = call("POST", f"/v1/workspaces/{WS}/expressions", me, body=choice)
    expr = result.get("expression") or result
    return expr["id"]


# 서버가 가로세로를 받는 닫힌 목록(ADR-0151 증보 9): 이 밖의 종류는 선언하지 않는다.
IMAGE_MIMES = ("image/jpeg", "image/png", "image/gif", "image/webp")


def image_size(path):
    """PNG·GIF·JPEG 의 가로세로를 머리 바이트에서 읽는다(표준 라이브러리만). 못 읽으면 None. 이 시드가 ffmpeg 로 만든 파일은 방향 표지가 없다."""
    with open(path, "rb") as handle:
        head = handle.read(1 << 16)
    if head[:8] == b"\x89PNG\r\n\x1a\n" and len(head) >= 24:
        return struct.unpack(">II", head[16:24])
    if head[:6] in (b"GIF87a", b"GIF89a") and len(head) >= 10:
        return struct.unpack("<HH", head[6:10])
    if head[:3] == b"\xff\xd8\xff":
        i = 2
        while i + 9 < len(head) and head[i] == 0xFF:
            marker = head[i + 1]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                height, width = struct.unpack(">HH", head[i + 5 : i + 9])
                return (width, height)
            i += 2 + struct.unpack(">H", head[i + 2 : i + 4])[0]
    return None


def declare_size(token, channel, attachment_id, path, mime):
    """올린 사진·GIF 의 가로세로를 선언한다. 덤이라 어떤 실패도 시드를 멈추지 않는다."""
    if args.no_declare_sizes or mime not in IMAGE_MIMES:
        return
    size = image_size(path)
    if size is None:
        return
    try:
        call("PUT", f"/v1/workspaces/{WS}/channels/{channel}/attachments/{attachment_id}/media", token,
             body={"kind": "image", "width": size[0], "height": size[1]}, retry=False)
    except SystemExit as err:
        print(f"declare size skipped for {os.path.basename(path)}: {err}", file=sys.stderr)


def upload_attachment(token, channel, filename, mime):
    path = os.path.join(MEDIA, filename)
    size = os.path.getsize(path)
    _, up = call("POST", f"/v1/workspaces/{WS}/channels/{channel}/attachments/uploads", token, body={"name": filename, "mime": mime, "size": size})
    req = urllib.request.Request(up["uploadUrl"], data=open(path, "rb").read(), method="PUT")
    req.add_header("Content-Type", mime)
    try:
        urllib.request.urlopen(req, timeout=60).read()
    except urllib.error.HTTPError as err:
        raise SystemExit(f"PUT {up['uploadUrl'][:80]} -> {err.code} {err.read()[:200]!r}")
    call("POST", f"/v1/workspaces/{WS}/channels/{channel}/attachments/{up['id']}/complete", token)
    declare_size(token, channel, up["id"], path, mime)
    return up["id"]


def send(token, channel, body, attachment_ids=None):
    payload = {"body": body, "clientMsgId": str(uuid.uuid4())}
    if attachment_ids:
        payload["attachmentIds"] = attachment_ids
    _, msg = call("POST", f"/v1/workspaces/{WS}/channels/{channel}/messages", token, body=payload)
    msg = msg.get("message") or msg
    return msg["id"]


FILLERS = [
    "오늘 점심 뭐 먹을까요?",
    "저는 김치찌개 생각 중이에요. 근처에 새로 생긴 집이 있다고 하더라고요.",
    "좋아요! 12시 반에 로비에서 만나요.",
    "회의 자료 공유드렸어요. 확인 부탁드립니다.",
    "네, 지금 보고 있어요. 두 번째 장표가 조금 길어 보이네요.",
    "맞아요, 숫자 표는 부록으로 넘길까요?",
    "그게 좋겠어요. 요약 한 장이면 충분할 것 같아요.",
    "배포는 오후 네 시로 잡았어요. 문제 있으면 말씀해 주세요.",
    "저는 괜찮아요. 롤백 계획도 같이 적어 둘게요.",
    "감사합니다!",
    "내일 오전 열 시에 스탠드업 있는 거 기억하시죠?",
    "네! 알람 맞춰 놨어요.",
    "지난주에 말한 디자인 시안 업데이트됐어요. 색이 조금 더 따뜻해졌어요.",
    "오 좋은데요. 버튼 모서리도 더 둥글어졌네요.",
    "맞아요, 그 부분은 피드백 반영했어요.",
    "점심 먹고 돌아오는 길에 커피 사 올게요. 뭐 드실래요?",
    "저는 아이스 아메리카노요.",
    "저도요!",
    "오늘 날씨가 정말 좋네요. 산책이라도 할까요?",
    "좋죠, 이십 분만 걷고 와요.",
]


def seed_channel(profile, me, peer, ids):
    """프로필 하나의 채널을 만들고 메시지를 오래된 것부터 보낸다. 채널 id 를 돌려준다."""
    suffix = time.strftime("%H%M%S")
    name = f"{args.name}-{profile}-{suffix}"
    _, ch = call("POST", f"/v1/workspaces/{WS}/channels", me, body={"kind": "public", "name": name})
    channel = (ch.get("channel") or ch)["id"]
    sql(f"""BEGIN;
SET LOCAL app.workspace_id = '{WS}';
SET LOCAL row_security = off;
INSERT INTO membership (workspace_id, channel_id, member_id, role) VALUES ('{WS}', '{channel}', '{ids['peer']}', 'member') ON CONFLICT DO NOTHING;
COMMIT;""")
    print("channel", name, channel, file=sys.stderr)
    link_ids = []

    def step(author, body, atts=None, unfurl=None, react=None):
        tok = me if author == "me" else peer
        attachment_ids = [upload_attachment(tok, channel, f, m) for (f, m) in (atts or [])]
        mid = send(tok, channel, body, attachment_ids)
        if unfurl:
            link_ids.append((mid, unfurl))
        for who, emoji in react or []:
            call("PUT", f"/v1/workspaces/{WS}/messages/{mid}/reactions/{urllib.parse.quote(emoji, safe='')}", me if who == "me" else peer)
        time.sleep(0.05)
        return mid

    for i in range(args.fillers):
        step("me" if i % 2 else "peer", FILLERS[i % len(FILLERS)])
    if profile == "entry":
        # 화면 위쪽 묶음(첫 화면 밖)
        step("peer", "세로 사진이에요", atts=[("photo-port.png", "image/png")])
        step("me", ":big_sticker:")
        step("peer", "방금 그거 봤어요? ㅋㅋㅋ")
        step("me", "움직이는 첨부", atts=[("anim.gif", "image/gif")])
        # 첫 화면(맨 아래) 묶음
        step("peer", "이 글 한번 보세요 https://example.invalid/articles/oort-mobile-tips 정리가 잘 돼 있어요", unfurl={"title": "oort 모바일 팁 모음", "description": "대화를 더 빠르게 쓰는 방법 열 가지", "domain": "example.invalid", "site": "Example"})
        step("me", ":groove_gif:")
        step("peer", "가로 사진도 올려요", atts=[("photo-land.jpg", "image/jpeg")])
        step("me", ":big_sticker:")
        step("peer", ":big_sticker: :wide_sticker:")
        step("me", "오늘도 수고했어요 :tiny_smile: 내일 봐요")
        step("peer", "마지막 글이에요", react=[("me", "👍"), ("peer", "👍"), ("me", ":tiny_smile:"), ("peer", ":big_sticker:")])
        step("me", "확인했어요!")
    else:
        # 누르기 시험용: 정지 큰 이모티콘 하나(위), 5초짜리 움직이는 이모티콘 하나(아래), 글 하나 — 줄이 겹치지 않는다.
        step("peer", "눌러 볼게요")
        step("me", ":wide_sticker:")
        step("peer", ":slow_gif:")
        step("me", "확인했어요!")
    # 링크 카드: 외부 접속 없이 직접 심는다.
    for mid, meta in link_ids:
        url = "https://example.invalid/articles/oort-mobile-tips"
        sql(f"""BEGIN;
SET LOCAL app.workspace_id = '{WS}';
SET LOCAL row_security = off;
DELETE FROM unfurl_job WHERE message_id = '{mid}';
INSERT INTO message_unfurl (workspace_id, channel_id, message_id, url_key, source_url, status, title, description, domain, site_name, fetched_at, expires_at)
VALUES ('{WS}', '{channel}', '{mid}', '{url}', '{url}', 'ok', '{meta['title']}', '{meta['description']}', '{meta['domain']}', '{meta['site']}', now(), now() + interval '1 day')
ON CONFLICT (message_id, url_key) DO UPDATE SET status = 'ok', title = EXCLUDED.title, description = EXCLUDED.description, domain = EXCLUDED.domain, site_name = EXCLUDED.site_name;
COMMIT;""")
    # 읽음: 첫 진입에 「안 읽은 동안」 카드·「새 메시지」 알약이 서지 않게 내 커서를 끝으로 옮긴다.
    call("PUT", f"/v1/workspaces/{WS}/channels/{channel}/read-state", me, body={"last_read_seq": 1000000, "read_intent": "explicit_open"})
    return channel


def main():
    profiles = [p.strip() for p in args.profile.split(",") if p.strip()]
    for profile in profiles:
        if profile not in ("entry", "taps"):
            raise SystemExit("--profile 은 entry, taps 또는 쉼표로 이은 둘이에요")
    make_media()
    ids = ensure_members()
    me = login(ME_EMAIL, ME_PW)
    peer = login(PEER_EMAIL, PEER_PW)
    register(me, "big_sticker", "큰 스티커", "big.png", "image/png", "sticker")
    register(me, "groove_gif", "움직이는 스티커", "groove.gif", "image/gif", "sticker")
    register(me, "tiny_smile", "작은 웃음", "tiny.png", "image/png", "emoji")
    register(me, "wide_sticker", "넓은 스티커", "wide.png", "image/png", "sticker")
    register(me, "slow_gif", "느린 스티커", "slow.gif", "image/gif", "sticker")
    channels = {profile: seed_channel(profile, me, peer, ids) for profile in profiles}
    state = {
        "api": API, "workspace": WS, "channels": channels, "channel": channels[profiles[0]],
        "me": {"email": ME_EMAIL, "password": ME_PW, "id": ids["me"]},
        "peer": {"email": PEER_EMAIL, "password": PEER_PW, "id": ids["peer"]},
    }
    text = json.dumps(state, indent=2, ensure_ascii=False)
    if args.out:
        with open(args.out, "w") as fh:
            fh.write(text)
        os.chmod(args.out, 0o600)  # 계정 비밀번호가 들어 있다
        print("state ->", args.out)
    else:
        print(text)


if __name__ == "__main__":
    main()
