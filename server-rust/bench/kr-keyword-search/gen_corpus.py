#!/usr/bin/env python3
"""MEM-M0 (#3159) 한국어 키워드 검색 스파이크 — 합성 코퍼스·질의 생성기 (시드 고정, 실제 대화 미사용).

산출(fixtures/):
  corpus.jsonl   {"id","text","concept"}   팀 대화 풍 문장. concept = 정답 개념 id 또는 null(잡음)
  queries.json   [{"id","text","kind","relevant":[doc id...]}]  50쌍 — #3160이 그대로 재사용
  scale.jsonl    (--scale N) 지연·크기 측정용 잡음 문서. 정답 라벨 없음.

정답 규칙: 개념 c = (낱말 A, 낱말 B). 문서 d가 c의 정답 <=> d가 A와 B를 함께 담도록 생성됨.
다른 개념의 문서·잡음은 A/B 중 한쪽만 담거나 둘 다 담지 않는다(짝은 개념마다 유일).
"""
import argparse, json, random, sys

SEED = 20260929
# 공통 명사 풀 (2음절 위주). 개념 짝은 여기서 뽑고 서로 겹칠 수 있으나 짝은 유일.
NOUNS = ["배포", "결재", "회의", "검수", "승인", "일정", "예산", "장애", "권한", "공지",
         "정산", "채용", "계약", "견적", "보안", "백업", "복구", "설계", "기획", "출시",
         "마감", "보고", "발표", "교육", "휴가", "점검", "개선", "협의", "요청", "검토"]
# 붙여쓰기/띄어쓰기 변형이 있는 복합어 (표기 a=붙여, b=띄어)
COMPOUND = [("팀기억", "팀 기억"), ("고객사", "고객 사"), ("업무일지", "업무 일지"),
            ("회의록", "회의 록"), ("배포계획", "배포 계획"), ("장애보고", "장애 보고"),
            ("예산안", "예산 안"), ("검수기준", "검수 기준"), ("출시일정", "출시 일정"),
            ("권한설정", "권한 설정")]
ENG = ["PR", "API", "QA", "CI", "DB", "SLA", "OKR", "MVP"]
ENG_V = ["리뷰", "머지", "릴리스", "롤백", "핫픽스"]   # "PR 리뷰"류 영문 혼용
FILL = ["다음 주까지", "오늘 오후에", "팀원들과", "일단", "가능하면", "내일 아침", "지난번처럼",
        "우선순위대로", "조용히", "천천히", "같이", "빠르게", "따로", "한 번 더", "모두에게"]
TAIL = ["진행하기로 했어요", "확인 부탁드려요", "공유드립니다", "다시 얘기해 봐요", "정리해서 올릴게요",
        "어떻게 생각하세요", "문제 없는지 봐 주세요", "마무리했습니다", "미뤄질 것 같아요", "논의가 필요해요"]
# 개념과 무관한 잡음용 어휘 (NOUNS/COMPOUND/ENG와 겹치지 않음)
NOISE_N = ["점심", "커피", "날씨", "주말", "영화", "운동", "택배", "노트북", "의자", "프린터",
           "와이파이", "엘리베이터", "간식", "생일", "퇴근", "출근", "우산", "충전기", "책상", "화분"]

def has_batchim(ch):
    c = ord(ch) - 0xAC00
    return 0 <= c < 11172 and (c % 28) != 0

def is_rieul(ch):
    c = ord(ch) - 0xAC00
    return 0 <= c < 11172 and (c % 28) == 8

def josa(word, kind):
    """kind: eul, i, eun, gwa, ro, e, eseo, do, man, ui, none"""
    last = word[-1]
    b = has_batchim(last)
    if not ('가' <= last <= '힣'):     # 영문 등 끝: 발음상 받침 없음 취급(PR→피알 받침 없음)
        b = False
    return {"eul": "을" if b else "를", "i": "이" if b else "가", "eun": "은" if b else "는",
            "gwa": "과" if b else "와", "ro": "으로" if (b and not is_rieul(last)) else "로",
            "e": "에", "eseo": "에서", "do": "도", "man": "만", "ui": "의", "none": ""}[kind]

KINDS = ["eul", "i", "eun", "gwa", "ro", "e", "eseo", "do", "man", "ui", "none"]

def with_josa(rng, word):
    return word + josa(word, rng.choice(KINDS))

def typo(rng, word):
    """한글 음절 1자를 같은 초성/중성 또는 인접 자음으로 바꾼 오타(길이 유지)."""
    idx = [i for i, ch in enumerate(word) if '가' <= ch <= '힣']
    i = rng.choice(idx)
    c = ord(word[i]) - 0xAC00
    cho, jung, jong = c // 588, (c % 588) // 28, c % 28
    for _ in range(20):
        if rng.random() < 0.5:
            n = (cho + rng.choice([-1, 1, 2, -2])) % 19
            nc = (n * 588) + jung * 28 + jong
        else:
            n = (jung + rng.choice([-1, 1, 2, -2])) % 21
            nc = cho * 588 + n * 28 + jong
        cand = word[:i] + chr(0xAC00 + nc) + word[i + 1:]
        if cand != word:
            return cand
    raise RuntimeError

def sentence(rng, parts):
    """parts: 개념 낱말들(이미 josa/표기 결정됨) → 팀 대화 풍 문장."""
    order = parts[:]
    rng.shuffle(order)
    toks = []
    if rng.random() < 0.6:
        toks.append(rng.choice(FILL))
    toks.append(order[0])
    if rng.random() < 0.5:
        toks.append(rng.choice(FILL))
    toks.append(order[1])
    toks.append(rng.choice(TAIL))
    return " ".join(toks)

def surface(rng, w):
    """개념 낱말 w(표기 튜플 또는 문자열) → 문서 표기."""
    if isinstance(w, tuple):
        return w[0] if rng.random() < 0.5 else w[1]
    return w

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="fixtures")
    ap.add_argument("--scale", type=int, default=0, help="지연 측정용 잡음 문서 수(scale.jsonl)")
    a = ap.parse_args()
    rng = random.Random(SEED)

    # --- 개념 50개: 종류별 10개 --------------------------------------------
    pool = NOUNS[:]
    rng.shuffle(pool)
    pairs = set()
    def pick_pair(first_pool, second_pool):
        while True:
            x, y = rng.choice(first_pool), rng.choice(second_pool)
            if x != y and (x, y) not in pairs and (y, x) not in pairs:
                pairs.add((x, y)); return x, y
    concepts = []   # dict(id, kind, A, B, qA, qB)
    def add(kind, A, B):
        concepts.append({"id": f"c{len(concepts):02d}", "kind": kind, "A": A, "B": B})
    for _ in range(10): add("josa", *pick_pair(NOUNS, NOUNS))          # 조사 변형: 질의와 문서의 조사가 다르게
    for _ in range(10): add("two_syllable", *pick_pair(NOUNS, NOUNS))  # 두 음절 낱말 그대로
    for i in range(10):                                                 # 붙여쓰기/띄어쓰기
        add("spacing", COMPOUND[i], rng.choice(NOUNS))
    for _ in range(10):                                                 # 영문 혼용
        add("english", rng.choice(ENG), rng.choice(ENG_V)) if False else add(
            "english", rng.choice(ENG), rng.choice(NOUNS + ENG_V))
    for _ in range(10): add("typo", *pick_pair(NOUNS, NOUNS))          # 질의에 1자 오타
    # 영문 짝 유일성
    seen = set()
    for c in concepts:
        k = (str(c["A"]), str(c["B"]))
        if k in seen: raise SystemExit("duplicate pair")
        seen.add(k)

    docs = []
    def add_doc(text, concept):
        docs.append({"id": f"d{len(docs):04d}", "text": text, "concept": concept})

    # 정답 문서 8개/개념 (400)
    for c in concepts:
        for _ in range(8):
            A, B = surface(rng, c["A"]), surface(rng, c["B"])
            # 조사는 한글로 끝나는 낱말에만 붙이고 영문은 "PR을" 식으로 붙임
            add_doc(sentence(rng, [with_josa(rng, A), with_josa(rng, B)]), c["id"])
    # 한쪽만 담은 방해 문서 4개+4개/개념 (400 → 총 800에서 잡음 200 이후 조정)
    for c in concepts:
        for which in ("A", "B"):
            for _ in range(3):
                x = surface(rng, c[which])
                other = rng.choice(NOISE_N)
                # 다른 개념의 반대쪽 낱말을 섞어 A/B 한쪽만 나오게 보장
                y = other
                add_doc(sentence(rng, [with_josa(rng, x), with_josa(rng, y)]), None)
    # 개념 없는 잡음 200
    for _ in range(200):
        add_doc(sentence(rng, [with_josa(rng, rng.choice(NOISE_N)), with_josa(rng, rng.choice(NOISE_N))]), None)

    # 방해 문서가 우연히 정답 조건을 만족하지 않는지 검증(낱말 포함 검사)
    def contains(text, w):
        if isinstance(w, tuple): return w[0] in text or w[1] in text
        return w in text
    qs = []
    for c in concepts:
        rel = [d["id"] for d in docs if d["concept"] == c["id"]]
        for d in docs:
            if d["concept"] != c["id"] and contains(d["text"], c["A"]) and contains(d["text"], c["B"]):
                raise SystemExit(f"label leak {c['id']} {d['id']}")
        A = c["A"][0] if isinstance(c["A"], tuple) else c["A"]
        B = c["B"][0] if isinstance(c["B"], tuple) else c["B"]
        if c["kind"] == "josa":
            # 질의 조사를 무작위 하나로 고정하되 문서와 다른 형태가 많도록 '를/가' 등 고정
            qa, qb = A + josa(A, "eul"), B + josa(B, "i")
        elif c["kind"] == "two_syllable":
            qa, qb = A, B
        elif c["kind"] == "spacing":
            # 질의는 문서의 절반과 반대 표기 — 붙여쓰기 질의 / 띄어쓰기 질의 번갈아
            idx = int(c["id"][1:]) % 2
            qa = c["A"][idx]; qb = B
        elif c["kind"] == "english":
            qa, qb = A, B
        else:  # typo
            qa, qb = typo(rng, A), B
        qs.append({"id": f"q{len(qs):02d}", "text": f"{qa} {qb}", "kind": c["kind"],
                   "concept": c["id"], "relevant": rel})
    # 방해/잡음 문서 순서 섞기(안정적): 시드 고정 셔플 후 id 재부여
    rng.shuffle(docs)
    remap = {}
    for i, d in enumerate(docs):
        new = f"d{i:04d}"; remap[d["id"]] = new; d["id"] = new
    for q in qs:
        q["relevant"] = sorted(remap[r] for r in q["relevant"])

    import os
    os.makedirs(a.out, exist_ok=True)
    with open(f"{a.out}/corpus.jsonl", "w", encoding="utf-8") as f:
        for d in docs: f.write(json.dumps(d, ensure_ascii=False) + "\n")
    with open(f"{a.out}/queries.json", "w", encoding="utf-8") as f:
        json.dump(qs, f, ensure_ascii=False, indent=1)
    if a.scale:
        r2 = random.Random(SEED + 1)
        with open(f"{a.out}/scale.jsonl", "w", encoding="utf-8") as f:
            for i in range(a.scale):
                ws = [r2.choice(NOISE_N + NOUNS), r2.choice(NOISE_N)]  # 둘째는 항상 잡음 낱말 → 개념 짝(A,B) 동시 포함 불가
                t = sentence(r2, [with_josa(r2, ws[0]), with_josa(r2, ws[1])])
                f.write(json.dumps({"id": f"s{i:06d}", "text": t, "concept": None}, ensure_ascii=False) + "\n")
    print(f"docs={len(docs)} queries={len(qs)}", file=sys.stderr)

if __name__ == "__main__":
    main()
