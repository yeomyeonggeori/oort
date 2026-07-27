#!/usr/bin/env python3
"""서버 소스에 등록된 /v1 라우트를 추출해 역방향 커버리지 매니페스트로 낸다.

왜 손으로 쓰지 않는가: 손으로 쓴 목록은 **이미 고친 것의 체크리스트**일 뿐이라,
다음에 누가 스펙 없이 라우트를 추가하면 그대로 통과한다. MOMO-633이 잡은 드리프트가
정확히 그렇게 생겼다. 매니페스트가 소스에서 유도돼야 새 라우트가 자동으로 감시된다.

경로 파라미터는 이름이 아니라 **위치**로 비교한다 — 서버는 `:ws`, 스펙은
`{workspaceId}`로 같은 자리를 다르게 부른다.

    python3 scripts/openapi_server_routes.py --routes-dir server/Sources/MomoServer/Routes \
        [--allowlist docs/api/openapi.undocumented-allowlist.json] > manifest.json
"""
import argparse
import json
import pathlib
import re
import sys

ROUTE_RE = re.compile(r'group\.(get|post|put|delete|patch)\(\s*"(/v1/[^"]*)"')


def normalize(path: str) -> str:
    """파라미터 이름을 지우고 위치만 남긴다."""
    path = re.sub(r"\{[^}]+\}", "{}", path)
    return re.sub(r":[A-Za-z_][A-Za-z0-9_]*", "{}", path)


def extract(routes_dir: pathlib.Path):
    found = set()
    for source in sorted(routes_dir.glob("*.swift")):
        for method, path in ROUTE_RE.findall(source.read_text(encoding="utf-8")):
            found.add((method, normalize(path)))
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--routes-dir", required=True)
    parser.add_argument(
        "--allowlist",
        help="아직 문서화되지 않은 기존 경로 목록. 여기 있는 것만 면제되고, "
        "새로 생긴 미문서화 경로는 게이트가 잡는다.",
    )
    args = parser.parse_args()

    routes_dir = pathlib.Path(args.routes_dir)
    if not routes_dir.is_dir():
        print(f"routes dir not found: {routes_dir}", file=sys.stderr)
        return 1

    operations = extract(routes_dir)
    if not operations:
        print(f"no /v1 routes found under {routes_dir}", file=sys.stderr)
        return 1

    exempt = set()
    if args.allowlist:
        payload = json.loads(pathlib.Path(args.allowlist).read_text(encoding="utf-8"))
        exempt = {
            (item["method"].lower(), normalize(item["path"]))
            for item in payload.get("operations", [])
        }
        # 이미 문서화된 경로가 면제 목록에 남아 있으면 목록이 낡은 것이다.
        stale = sorted(exempt - operations)
        if stale:
            print(
                "allowlist has entries that no longer exist in the server: "
                + ", ".join(f"{m.upper()} {p}" for m, p in stale),
                file=sys.stderr,
            )
            return 1

    json.dump(
        {
            "operations": [
                {"method": m, "path": p} for m, p in sorted(operations - exempt)
            ]
        },
        sys.stdout,
        indent=2,
        ensure_ascii=False,
    )
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
