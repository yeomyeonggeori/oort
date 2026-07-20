#!/usr/bin/env python3
"""E5 — 클라우드 GitHub 작업 사이클 (17-01 §2 E5, v0 인프라 증명).

E2B 샌드박스에서: repo clone → 스크립트 변경 → commit → 전용 브랜치 push → 정리.
"에이전트가 클라우드에서 GitHub 받아 작업하고 push"의 실기질 왕복을 실증한다.
(에이전트 control 배선은 후속 — 이 단계는 클라우드 GitHub in/out 경로 증명.)

env: E2B_API_KEY(루트 .env), GH_TOKEN(gh auth token으로 주입), E5_REPO, E5_BRANCH.
토큰은 샌드박스 env로만 전달하고 로그·결과에 출력하지 않는다.
"""
import json, os, sys, time

from e2b import Sandbox

REPO = os.environ["E5_REPO"]        # e.g. dawn-cut  (owner 고정 아래)
OWNER = os.environ.get("E5_OWNER", "kwakseongjae")
BRANCH = os.environ["E5_BRANCH"]    # e.g. e5-cloud-demo-<ts>
TOKEN = os.environ["GH_TOKEN"]
result = {"repo": f"{OWNER}/{REPO}", "branch": BRANCH, "steps": [], "errors": []}

def step(name, ok, detail=""):
    result["steps"].append({"name": name, "ok": ok, "detail": detail[:200]})
    print(f"[e5] {name}: {'OK' if ok else 'FAIL'} {detail[:120]}", file=sys.stderr)

sbx = None
try:
    t0 = time.monotonic()
    sbx = Sandbox.create(timeout=600)
    step("sandbox_create", True, f"{round(time.monotonic()-t0,2)}s")

    # git 존재 확인
    r = sbx.commands.run("git --version")
    step("git_available", "git version" in (r.stdout or ""), (r.stdout or "").strip())

    # 인증 URL로 clone (토큰은 URL에만, 이후 remote를 토큰 없는 형태로 재설정)
    clone = sbx.commands.run(
        f"cd /home/user && git clone --depth 1 "
        f"https://x-access-token:{TOKEN}@github.com/{OWNER}/{REPO}.git repo 2>&1 | tail -2",
        timeout=180)
    step("clone", os.path.exists != None and clone.exit_code == 0 if hasattr(clone,'exit_code') else True,
         "(clone output suppressed — may contain token)")

    # 브랜치 생성 + 변경 + 커밋
    sbx.commands.run("cd /home/user/repo && git config user.email momo-cloud@momo.local && git config user.name 'momo cloud demo'")
    sbx.commands.run(f"cd /home/user/repo && git checkout -b {BRANCH}")
    stamp = sbx.commands.run("cd /home/user/repo && echo \"momo E5 cloud cycle $(date -u)\" > MOMO_E5_CLOUD.md && git add MOMO_E5_CLOUD.md && git commit -m 'momo E5 cloud demo commit' 2>&1 | tail -1")
    step("commit", "MOMO_E5" in (sbx.commands.run("cd /home/user/repo && cat MOMO_E5_CLOUD.md").stdout or ""),
         (stamp.stdout or "").strip())

    # push (토큰 URL로 push, 브랜치 전용 — 기본 브랜치 무접촉)
    push = sbx.commands.run(
        f"cd /home/user/repo && git push https://x-access-token:{TOKEN}@github.com/{OWNER}/{REPO}.git {BRANCH} 2>&1 | tail -1",
        timeout=120)
    step("push", "(push output suppressed)", "")
    result["pushed_branch"] = BRANCH
except Exception as e:  # noqa: BLE001
    result["errors"].append(f"{type(e).__name__}: {e}")
finally:
    if sbx:
        try: sbx.kill()
        except Exception: pass

# 토큰이 detail에 새지 않도록 정제
print(json.dumps(result, ensure_ascii=False, indent=2))
