#!/usr/bin/env python3
"""E3 — 샌드박스 내 구독 OAuth 로그인 준비 (17-01 §2 E3).

목표: E2B 샌드박스에서 Claude Code CLI를 설치하고 구독(Max) 로그인 URL+코드를
성재에게 노출 → 폰 인증 → 자격증명 볼륨 영속 → pause/resume·재기동 후 유지 확인.

이 스크립트는 두 단계:
  --stage login  : 샌드박스 생성·CLI 설치·로그인 시작, URL/코드 출력, 샌드박스 유지(snapshot id 저장)
  --stage verify : 저장된 snapshot에 resume해 로그인 상태(claude whoami류) 확인

env: E2B_API_KEY. E3_SNAPSHOT(verify 단계 입력). 개인 토큰은 샌드박스 내부에만.
"""
import json, os, sys, time

from e2b import Sandbox

STAGE = os.environ.get("E3_STAGE", "login")
SNAP_FILE = os.environ.get("E3_SNAPSHOT_FILE", "/tmp/e3-snapshot.txt")

def login_stage():
    sbx = Sandbox.create(timeout=1800)
    # Node 확인 후 Claude Code CLI 설치 (구독 로그인 지원 경로)
    node = sbx.commands.run("node --version 2>&1 || echo NO_NODE", timeout=30)
    print(f"[e3] node: {(node.stdout or '').strip()}", file=sys.stderr)
    install = sbx.commands.run(
        "npm install -g @anthropic-ai/claude-code 2>&1 | tail -3", timeout=600)
    print(f"[e3] install tail: {(install.stdout or '').strip()[-200:]}", file=sys.stderr)
    # 헤드리스 로그인 시작 — URL+코드 방식(CLI가 device/URL 플로우를 stdout에 출력)
    # 실제 커맨드는 CLI 버전에 따라 다를 수 있어 후보를 순차 시도하고 출력을 그대로 노출.
    login = sbx.commands.run(
        "claude --version 2>&1; echo '---'; (claude setup-token 2>&1 || claude login 2>&1) | head -30",
        timeout=120)
    sbx.pause(keep_memory=True)
    with open(SNAP_FILE, "w") as f:
        f.write(sbx.sandbox_id)
    print(json.dumps({
        "stage": "login",
        "sandbox_id": sbx.sandbox_id,
        "snapshot_file": SNAP_FILE,
        "cli_version_and_login_output": (login.stdout or "").strip(),
        "next": "출력의 URL을 폰/브라우저에서 열어 Max 구독 인증 → 코드가 있으면 verify 단계에서 주입",
    }, ensure_ascii=False, indent=2))

def verify_stage():
    sid = os.environ.get("E3_SNAPSHOT") or open(SNAP_FILE).read().strip()
    sbx = Sandbox.connect(sid)
    who = sbx.commands.run("claude whoami 2>&1 || claude --version 2>&1 | head -3", timeout=60)
    persist = sbx.commands.run("ls -la ~/.claude* 2>&1 | head -5", timeout=30)
    sbx.pause(keep_memory=True)
    print(json.dumps({
        "stage": "verify", "sandbox_id": sid,
        "whoami": (who.stdout or "").strip(),
        "credential_files": (persist.stdout or "").strip(),
    }, ensure_ascii=False, indent=2))

(login_stage if STAGE == "login" else verify_stage)()
