// 「유리 배경」 행의 문구 (AP-3 #4190, 청사진 §5.3-e 문구 표). 컴포넌트 파일이 객체를 내보내면 빠른 새로
// 고침 규칙(`react-refresh/only-export-components`)이 경고하므로 문구는 이 파일에 둔다. 행과 시험이 같은
// 문장을 읽는다.

export const GLASS_COPY = {
  label: "유리 배경",
  supported: "내비게이션 뒤로 데스크탑을 흐리게 비추고, 대화 영역은 그대로 또렷해요.",
  unsupported: "macOS 데스크탑 앱에서 쓸 수 있어요.",
  unusable: "이 테마에서는 글자가 읽히도록 유리 배경을 쓸 수 없어요.",
  wallpaper: "배경화면이 켜져 있어서 유리 배경을 쓸 수 없어요. 배경화면을 끄면 다시 켤 수 있어요.",
  failed: "이 기기에서는 유리 배경을 켜지 못했어요.",
  reducedTransparency: "시스템 설정이 투명 효과를 끄고 있어요.",
  opacityLabel: "유리 불투명도",
  opacityHint: (min: number): string =>
    `낮출수록 데스크탑이 더 비쳐요. 글자가 읽히도록 이 테마에서는 ${min}% 아래로 내릴 수 없어요.`,
  valueText: (percent: number): string => `${percent}% 불투명`,
  reset: "기본값으로 되돌리기",
} as const;
