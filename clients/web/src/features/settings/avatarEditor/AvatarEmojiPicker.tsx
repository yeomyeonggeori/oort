import { useEffect, useRef, useState } from "react";
import { AVATAR_EDITOR_COPY } from "@momo/core/features/workspace/avatarEditor";
import { loadCatalog, type CatalogEmoji } from "@/features/emoji/catalog";
import { PICKER_EMOJI } from "@/features/emoji/EmojiPickerDialog";
import { EmojiPickerPanel } from "@/features/emoji/EmojiPickerPanel";
import "./avatarEditor.css";

// 아바타 이모지 고르기 (#4261): 컴포저·반응·상태 글이 쓰는 같은 목록(`EmojiPickerPanel`)을 대화상자 **안에** 놓는다.
// 같은 카탈로그(emojibase compact + iamcal 숏코드, 같은 오리진 번들), 같은 검색·피부색·「자주 쓰는」 목록이라
// 한 번 익힌 손이 그대로 통한다. 떠 있는 팝오버(`EmojiPickerDialog`)를 대화상자 안에 또 열지 않는 이유는 그 안의
// 포커스 영역 다툼이 이미 문서로 남아 있어서다(EmojiPickerDialog 머리말). 패널은 그 껍데기와 따로 선다.
//
// 이모지를 고른다고 닫히지 않는다: 고르면 위 미리보기가 바뀌고, 색을 더 고르고 저장한다.
//
// **「자주 쓰는」 기록에 넣지 않는다**(design-review H-2). 그 기록은 컴포저·반응·메시지 호버 툴바의 한 번 클릭 슬롯(「👍 ✅ 🙏」)이
// 읽는 공용 저장소라, 아바타로 고른 🚀 한 번이 메시지 툴바의 반응 단추를 바꾸고 이 격자의 순서도 방금 고른 칸이 첫 칸으로 가며
// 나머지가 한 칸씩 밀렸다(호버 툴바가 막아 둔 「클릭이 글리프를 재배열한다」 결함이 이 표면에서 되살아났다). 아바타 고르기는
// 반응을 남기는 일이 아니다.
//
// 카탈로그 실패·오프라인·빈 검색의 문장은 이 대화상자의 어조(해요체)로 넘긴다(패널 기본은 컴포저와 같은 합쇼체다).

export function AvatarEmojiPicker({
  onPick,
  skinOpen,
  onSkinOpenChange,
}: {
  onPick: (emoji: string) => void;
  skinOpen: boolean;
  onSkinOpenChange: (open: boolean) => void;
}) {
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [entries, setEntries] = useState<CatalogEmoji[] | null>(null);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setError(false);
    loadCatalog().then(
      (catalog) => {
        if (live) setEntries(catalog);
      },
      () => {
        if (live) {
          setEntries(null);
          setError(true);
        }
      }
    );
    return () => {
      live = false;
    };
  }, [nonce]);

  return (
    <div className="avatar-emoji-picker" data-testid="avatar-emoji-picker">
      <EmojiPickerPanel
        itemPrefix="avatar-emoji"
        entries={entries}
        loading={!error && entries === null}
        error={error}
        onRetry={() => {
          setError(false);
          setEntries(null);
          setNonce((n) => n + 1);
        }}
        onPick={(emoji) => onPick(emoji)}
        copy={AVATAR_EDITOR_COPY.emojiPanel}
        seed={PICKER_EMOJI}
        searchRef={searchRef}
        skinOpen={skinOpen}
        onSkinOpenChange={onSkinOpenChange}
        autoFocusSearch={false}
      />
    </div>
  );
}
