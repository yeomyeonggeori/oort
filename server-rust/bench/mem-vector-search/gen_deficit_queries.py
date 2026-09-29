#!/usr/bin/env python3
"""MEM-M3 (#3173) 결손 질의 생성기. 키워드 검색이 놓칠 것으로 예상되는 질의 종류를 M0 코퍼스(변경 없음) 위에 만든다.
시드 고정·결정적. 정답 = 그 개념의 정답 문서(A와 B를 함께 담은 8건, M0 라벨 그대로).

종류(질의 문서 수):
  synonym  개념 낱말 A·B 둘 다 유의어로 바꿈(코퍼스에 없는 낱말) — 배포·결재 → 반영·품의
  translit A·B 둘 다 영문/외래어 표기로 바꿈 — 배포 → deploy/디플로이
  abbrev   약어 A(PR, QA…)를 풀어쓴 이름으로, B는 그대로
  question 의문문 재서술: A는 그대로, B는 유의어, 「어떻게 됐지」류 채움말 포함
입력: ../kr-keyword-search/fixtures/{queries.json,corpus.jsonl} 출력: fixtures/queries_deficit.json
"""
import json, os, random, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
M0 = os.path.join(HERE, "..", "kr-keyword-search", "fixtures")
SEED = 20260930
N = {"synonym": 12, "translit": 12, "question": 12}

SYN = {"배포": "반영", "결재": "품의", "회의": "모임", "검수": "인수확인", "승인": "컨펌", "일정": "스케줄",
       "예산": "비용계획", "장애": "서비스중단", "권한": "접근허용", "공지": "안내문", "정산": "대금처리",
       "채용": "인재영입", "계약": "협약서", "견적": "가격제안", "보안": "방어체계", "백업": "복제본",
       "복구": "원상회복", "설계": "구조도안", "기획": "구상", "출시": "론칭", "마감": "기한",
       "보고": "경과전달", "발표": "피칭", "교육": "연수", "휴가": "연차", "점검": "살펴보기",
       "개선": "고도화", "협의": "조율", "요청": "의뢰", "검토": "따져보기"}
TRANS = {"배포": ["deploy", "디플로이"], "결재": ["sign-off", "사인오프"], "회의": ["meeting", "미팅"],
         "검수": ["acceptance", "어셉턴스"], "승인": ["approve", "어프루브"], "일정": ["schedule", "타임라인"],
         "예산": ["budget", "버짓"], "장애": ["incident", "인시던트"], "권한": ["permission", "퍼미션"],
         "공지": ["notice", "노티스"], "정산": ["settlement", "세틀먼트"], "채용": ["hiring", "리크루팅"],
         "계약": ["contract", "컨트랙트"], "견적": ["quote", "쿼트"], "보안": ["security", "시큐리티"],
         "백업": ["backup", "스냅샷"], "복구": ["recovery", "리커버리"], "설계": ["design", "디자인"],
         "기획": ["planning", "플래닝"], "출시": ["launch", "런칭"], "마감": ["deadline", "데드라인"],
         "보고": ["report", "리포트"], "발표": ["presentation", "프레젠테이션"], "교육": ["training", "트레이닝"],
         "휴가": ["vacation", "바케이션"], "점검": ["checkup", "헬스체크"], "개선": ["improvement", "임프루브먼트"],
         "협의": ["negotiation", "네고"], "요청": ["request", "리퀘스트"], "검토": ["examination", "이그재미네이션"]}
ABBR = {"PR": ["pull request", "풀리퀘스트"], "API": ["application programming interface", "애플리케이션 프로그래밍 인터페이스"],
        "QA": ["quality assurance", "품질 보증"], "CI": ["continuous integration", "지속적 통합"],
        "DB": ["database", "데이터베이스"], "SLA": ["service level agreement", "서비스 수준 협약"],
        "OKR": ["objectives and key results", "목표와 핵심 결과"], "MVP": ["minimum viable product", "최소 기능 제품"]}
QTPL = ["{a} 관련해서 {b} 어떻게 하기로 했더라?", "{b}랑 {a} 건 언제 얘기했지?", "{a} 얘기하다가 {b} 건은 어떻게 됐어?",
        "지난번에 {a}하고 {b} 어떻게 정리했는지 알려줄래?", "{a}, {b} 쪽은 결론이 뭐였어?"]

def strip_josa(w):
    return w[:-1] if w and w[-1] in "을를이가" and len(w) > 2 else w

def main():
    rng = random.Random(SEED)
    qs0 = json.load(open(f"{M0}/queries.json", encoding="utf-8"))
    corpus = [json.loads(l) for l in open(f"{M0}/corpus.jsonl", encoding="utf-8")]
    text_all = "\n".join(d["text"] for d in corpus)
    noun_c = []   # (concept, A, B, relevant)
    eng_c = []
    for q in qs0:
        if q["kind"] not in ("two_syllable", "josa", "english"):
            continue
        a, b = q["text"].split()
        if q["kind"] == "two_syllable":
            noun_c.append((q["concept"], a, b, q["relevant"]))
        elif q["kind"] == "josa":
            noun_c.append((q["concept"], strip_josa(a), strip_josa(b), q["relevant"]))
        elif q["kind"] == "english":
            eng_c.append((q["concept"], a, b, q["relevant"]))
    for _, a, b, _ in noun_c:
        assert a in SYN and b in SYN, (a, b)
    out = []
    def add(kind, c, text):
        out.append({"id": f"x{len(out):02d}", "text": text, "kind": kind, "concept": c[0], "orig": [c[1], c[2]], "relevant": c[3]})
    for c in rng.sample(noun_c, N["synonym"]):
        add("synonym", c, f"{SYN[c[1]]} {SYN[c[2]]}")
    for c in rng.sample(noun_c, N["translit"]):
        add("translit", c, f"{rng.choice(TRANS[c[1]])} {rng.choice(TRANS[c[2]])}")
    for c in eng_c:
        assert c[1] in ABBR, c
        add("abbrev", c, f"{rng.choice(ABBR[c[1]])} {c[2]}")
    for c in rng.sample(noun_c, N["question"]):
        a, b = (c[1], SYN[c[2]]) if rng.random() < 0.5 else (c[2], SYN[c[1]])
        add("question", c, rng.choice(QTPL).format(a=a, b=b))
    # 정합 점검: 유의어·번역어·풀이 표기가 코퍼스에 그대로 존재하면 순수 결손 질의가 아니다.
    banned = set(SYN.values()) | {x for v in TRANS.values() for x in v} | {x for v in ABBR.values() for x in v}
    for w in banned:
        if w in text_all:
            sys.exit(f"replacement word occurs in corpus: {w}")
    json.dump(out, open(f"{HERE}/fixtures/queries_deficit.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    from collections import Counter
    print(Counter(q["kind"] for q in out), len(out), file=sys.stderr)

if __name__ == "__main__":
    main()
