import json, hashlib, unicodedata, sys
INST="inst_01J9Z6T3QK8Y2W5N7M4R0P1XAB"
ws="00000000-0000-7000-8000-000000000001"
mem="00000000-0000-7000-8000-000000000101"
key="00000000-0000-7000-8000-00000000d003"
host="00000000-0000-7000-8000-00000000f001"
agent="00000000-0000-7000-8000-000000000a02"
chan="00000000-0000-7000-8000-00000000cc01"
thread="00000000-0000-7000-8000-00000000e001"
origin="00000000-0000-7000-8000-00000000e002"
def nfc(s): return unicodedata.normalize("NFC", s)
def case(name, n, agent_id, thread_id, origin_id, tool, folder, label, prompt):
    fields=dict(instance_id=INST, workspace_id=ws, member_id=mem, device_key_id=key, host_id=host, session_id=None,
        nonce="0193a5b8-7c1e-7d2a-9f00-00000000004%d"%n, issued_at_ms=1790550010000+n*1000, expires_at_ms=1790550610000+n*1000)
    content=dict(kind="spawn_task", agent_member_id=agent_id, folder_id=folder, tool=tool, channel_id=chan,
        thread_root_id=thread_id, origin_message_id=origin_id, label=label, prompt=prompt)
    A=lambda v: "-" if v is None else v
    canon="\n".join([A(agent_id), folder, tool, chan, A(thread_id), A(origin_id), nfc(label), nfc(prompt)])
    csha=hashlib.sha256(canon.encode()).hexdigest()
    payload="\n".join(["momo.human.control.v4", INST, ws, mem, key, host, "-", "spawn", "-", fields["nonce"],
        str(fields["issued_at_ms"]), str(fields["expires_at_ms"]), csha])
    return dict(name=name, schema="momo.human.control.v4", fields=fields, content=content,
        content_canonical=canon, content_sha256=csha, payload=payload,
        payload_sha256=hashlib.sha256(payload.encode()).hexdigest())
REJECTS=[
 dict(name="prompt_zero_width_space", field="prompt", value="빌드\u200b확인"),
 dict(name="prompt_right_to_left_override", field="prompt", value="파일 \u202etxt.exe"),
 dict(name="prompt_bidi_isolate", field="prompt", value="a\u2066b\u2069"),
 dict(name="prompt_variation_selector_supplement", field="prompt", value="x\U000e0100"),
 dict(name="prompt_soft_hyphen", field="prompt", value="soft\u00adhyphen"),
 dict(name="prompt_braille_blank", field="prompt", value="\u2800"),
 dict(name="prompt_hangul_filler", field="prompt", value="이름\u3164"),
 dict(name="prompt_private_use", field="prompt", value="x\ue000"),
 dict(name="prompt_tag_character", field="prompt", value="x\U000e0041"),
 dict(name="prompt_byte_order_mark", field="prompt", value="\ufeffhello"),
 dict(name="prompt_carriage_return", field="prompt", value="첫 줄\r\n둘째 줄"),
 dict(name="prompt_nul", field="prompt", value="a\u0000b"),
 dict(name="prompt_escape", field="prompt", value="a\u001b[31mb"),
 dict(name="prompt_c1_control", field="prompt", value="a\u0085b"),
 dict(name="prompt_blank", field="prompt", value=" \n\t "),
 dict(name="prompt_adapter_command", field="prompt", value="/clear"),
 dict(name="label_line_feed", field="label", value="두\n줄"),
 dict(name="label_tab", field="label", value="탭\t제목"),
 dict(name="label_zero_width_joiner_break", field="label", value="제\u200b목"),
 dict(name="label_right_to_left_override", field="label", value="\u202e제목"),
 dict(name="label_untrimmed", field="label", value=" 제목"),
 dict(name="label_empty", field="label", value=""),
]
ACCEPTS=[
 dict(name="prompt_line_feed_and_tab", field="prompt", value="첫 줄\n\t둘째 줄"),
 dict(name="prompt_emoji_presentation_selector", field="prompt", value="\u2764\ufe0f 고마워"),
 dict(name="prompt_korean_and_ascii", field="prompt", value="Fix the flaky test. 이슈 #3021도 봐 줘."),
 dict(name="label_plain", field="label", value="빌드 확인"),
 dict(name="label_emoji_presentation_selector", field="label", value="\u2764\ufe0f 확인"),
]
cases=[
 case("control_v4_spawn_personal_agent_in_thread",1,agent,thread,origin,"claude","fld_0123456789abcdef0123","빌드 확인","@kwak-claude 빌드가 왜 깨지는지 봐 줘\n첫째, 로그부터요. café"),
 case("control_v4_spawn_personal_agent_main_line",2,agent,None,origin,"codex","fld_0123456789abcdef0123","리서치","@kwak-codex 이 라이브러리 라이선스 알아봐 줘"),
 case("control_v4_spawn_harness_without_agent",3,None,None,None,"claude","fld_aaaaaaaaaaaaaaaaaaaa","질문","폴더 구조를 설명해 줘"),
 case("control_v4_spawn_nfd_text_signs_as_nfc",4,agent,None,origin,"claude","fld_0123456789abcdef0123","résumé","café 한글 확인"),
]
doc=dict(_comment="#3592 (P1) — momo.human.control.v4(새 작업 spawn 전용, ADR-0198 증보 1 T5 확정 1)의 공유 테스트 벡터. v1~v3와 같은 13줄 틀이고 첫 줄만 v4이며 spawn 본문은 8줄이다(에이전트|-, 폴더 id, 도구, 방, 스레드 루트|-, 원본 메시지|-, 제목(NFC), 프롬프트(NFC)). 서명은 담지 않는다: 서명은 스키마와 무관한 같은 ECDSA P-256 over payload이고 v1~v3 벡터가 세 서명자로 이미 고정한다. 이 파일은 입력(schema·fields·content)과 파생값(content_canonical·content_sha256·payload·payload_sha256)만 고정하며, Rust(momo-wire tests/human_control_v4_vectors.rs)·공유 코어(TS)·폰(TS)·데스크탑(Rust)이 같은 입력에서 같은 바이트를 다시 만든다. 비ASCII는 \\u 이스케이프로 적어 편집기의 NFC 정규화가 분해형 시험 문자열을 망가뜨리지 못하게 한다. 재생성: python3 server-rust/crates/momo-wire/tests/human_control_vectors/generate_v4.py > docs/api/human-control-signing-v4.vectors.json",
  format="momo.human.signing.vectors/v1", algorithm="payload bytes only (no signatures in this file)", cases=cases,
  text_rules=dict(
    _comment="#3592 리뷰 M2·L2 — 새 작업 spawn의 prompt·label이 받아들이는 글자의 공유 표. rejects는 서버(momo-wire spawn_prompt_problem·spawn_label_problem)·공유 코어(spawnPromptText·spawnLabelText, 폰이 재사용)·데스크탑 셸(spawn_prompt_ok·spawn_label_ok)이 모두 거절해야 하고, accepts는 모두 받아야 한다. 서명자가 사람에게 보이는 것과 host가 읽는 것이 달라지는 글자(제로폭·방향 제어·변형 선택자·주 제어문자)를 서명하지 않기 위해서다.",
    rejects=REJECTS, accepts=ACCEPTS))
sys.stdout.write(json.dumps(doc, ensure_ascii=True, indent=2)+"\n")
