# buzz 대비 oort 핵심 피쳐·UI 패리티 전수 감사 (2026-09-01)

> 읽기 전용 감사. 코드 실사 기준 워크트리 = `~/projects/momo-tracks/uxui`(track/uxui, HEAD `a6693e3d`) · `~/projects/momo-tracks/engine`(track/engine). 참조 = `~/projects/reference/buzz`.
> **경로 표기**: `web:` = `clients/web/src/…` · `core:` = `packages/momo-core/src/…` · `srv:` = `server-rust/bins/momo-server/src/…` · `buzz:` = `desktop/src/features/…`
> 판정 근거는 전부 파일 실사. 근거를 못 만든 축은 **미확인**으로 남겼고, 추정 판정은 넣지 않았다.

**중요 관측 — 리서치 커버리지의 실체**: 2026-08-10 buzz-audit **A~E는 UI 감사가 아니다**(A=라이선스/공개준비, B=배포 재현성, C=time-to-hello, D=운영준비, E=문서 드리프트). 즉 UI 패리티를 다룬 선행 문서는 사실상 `2026-08-29-buzz-ui-gap-candidates.md` **1본**(+온보딩 1본, 경쟁분석 §7 한 절)뿐이다. §3 사각지대가 넓은 것은 이 구조 때문이다.

---

## §1. buzz 기능 인벤토리 × oort 판정

축 47개. 판정: **완료 26 · 부분 11 · 미착수 8 · 의도적 제외 2**(+ buzz 고유 제품축은 별도 묶음).

### 1-A. 온보딩 · 계정

| # | 축 | buzz 근거 | oort 판정 | oort 근거 |
|---|---|---|---|---|
| 1 | 온보딩 스텝 셸(카운터·건너뛰기·전환 연출) | `buzz:onboarding/ui/OnboardingFlow.tsx`, `OnboardingSlideTransition.tsx`(effect 5종×방향) | **완료** | `web:features/auth/onboardingFlow.ts` 3스텝(landing/gateway/account)+`progressLabel` 2/3·3/3, `OnboardingSlideTransition.tsx`가 동일 effect 5종 이식 |
| 2 | 랜딩 코드 모션 마스코트 필드 | `buzz:onboarding/ui/LandingBees.tsx`(SVG 벌 40마리 rAF 배회+마우스 반발) | **완료** | `web:features/auth/OortCloudField.tsx`·`cloudBodies.ts`·`OortCloudMarks.tsx` |
| 3 | identity/키/백업 스텝 | `buzz:onboarding/ui/DownloadKeyStep.tsx`·`BackupStep.tsx`·`NsecMaskedDisplay.tsx` | **의도적 제외** | nostr 키 소유 모델 고유물. oort는 서버 계정 → `web:features/auth/ConnectPage.tsx`가 그 자리를 대체(리서치 §3 "구조 차이"에 사유 기록) |
| 4 | 웰컴 킥오프(에이전트가 먼저 말 거는 첫 5분) | `buzz:onboarding/welcomeKickoff.ts`·`useWelcomeKickoffStage.ts`·`ui/WelcomeKickoffStage.tsx` | **부분** | `web:features/hostedAgents/FirstMentionOnboarding.tsx`(첫 멘션 시점 안내)만 존재. 가입 직후 웰컴 채널 오프너 스테이지는 0건 |
| 5 | 초대 코드 리딤 / 조인 정책 게이트 | `buzz:onboarding/ui/InviteRedeemForm.tsx`·`PendingInviteGate.tsx`·`JoinPolicyNotice.tsx` | **완료** | `web:features/auth/ClaimPage.tsx`·`claimPath.ts`·`useJoinPrefill.ts` + `srv:routes/join.rs`·`invites.rs` |

### 1-B. 워크스페이스 · 사이드바

| # | 축 | buzz 근거 | oort 판정 | oort 근거 |
|---|---|---|---|---|
| 6 | 워크스페이스(커뮤니티) 레일·전환 | `buzz:sidebar/ui/CommunityRail.tsx`, `communities/useCommunities.tsx` | **완료** | `web:features/sidebar/WorkspaceRail.tsx`+`workspaceRailModel.ts`(테스트 동반), `features/workspace/AddWorkspaceDialog.tsx` |
| 7 | 사이드바 섹션 접기 + 접힌 헤더 unread 집계 | `buzz:sidebar/ui/SidebarSection.tsx` | **완료** (BZ-1) | `web:features/sidebar/sidebarSectionModel.ts` `sectionUnreadTotals`, `sidebarSectionPreference.ts`, `SidebarSection.test.tsx` |
| 8 | 사이드바 hover 액션 접근성(로빙/포커스) | `buzz:sidebar/ui/sidebarMenuHelpers.tsx` | **완료** | `sidebarSectionModel.ts` `shouldShowSectionActions`+`countSectionActionTabStops`(터치 hover:none 분기까지) |
| 9 | **커스텀 섹션**(생성·이름변경·아이콘·이동·해제) | `buzz:sidebar/ui/CustomChannelSection.tsx`·`ChannelSectionDialogs.tsx`("New section…", "Move to section", "Rename section", "Choose section icon") | **미착수** | `sidebarSectionModel.ts`의 `SidebarSectionId = "channels" \| "dms"` 고정 2종. 커스텀 섹션 코드 0건 |
| 10 | **채널 별표(Star)** | `buzz:sidebar/ui/ChannelContextMenu.tsx` "Star/Unstar channel" | **미착수** | 검색 0건 |
| 11 | **사이드바 정렬(A–Z / Recent) · DnD 재정렬** | `buzz:sidebar/ui/SidebarDnd.tsx`, `SidebarSection.tsx` "A–Z"/"Recent" | **미착수** | `features/sidebar`·`app/` 에 drag/reorder 코드 0건 |
| 12 | 채널 컨텍스트 메뉴 | buzz 11항목(mark read/unread, mute, star, move to section, archive, delete, leave, copy name/ID) | **부분** | oort는 헤더 메뉴에 주제·음소거·나가기·멤버만 — `web:features/chat/ChannelHeaderMenu.tsx`(`channel-mute-toggle`/`channel-leave`/`channel-topic`/`roster`). 우클릭 컨텍스트 메뉴 자체가 사이드바 행에 없음 |
| 13 | 사이드바 안읽음 점프 버튼 | `buzz:sidebar/ui/MoreUnreadButton.tsx` | **부분** | 키보드 경로만 존재(`web:app/keyboardShortcuts.ts` `MOVE_UNREAD_CHANNEL_SHORTCUT` ⌥↑/↓). 눈에 보이는 버튼 0 |
| 14 | 채널 활동 팝오버 | `buzz:sidebar/ui/ChannelActivityPopover.tsx` | **미착수** | 대응물 0건 |
| 15 | **채널 브라우저**(공개 채널 둘러보기) | `buzz:sidebar/ui/SidebarSection.tsx` "Browse channels", `channels/openChannelDirectory.ts` | **미착수** | oort는 ⌘K 팔레트의 클라 필터만(`web:app/QuickSwitcher.tsx`). 서버 채널 디렉터리 표면 0 |
| 16 | 채널 생성 다이얼로그 | `buzz:sidebar/ui/CreateChannelDialog.tsx` | **완료** | `web:features/channels/CreateChannelDialog.tsx`+`useCreateChannel.ts` |
| 17 | 연결 상태 카드 | `buzz:sidebar/ui/SidebarRelayConnectionCard.tsx` | **완료** | `web:features/sidebar/connStatusIndicator.ts`(테스트 동반)+`features/common/ConnectionBanner.tsx` |
| 18 | 사이드바 프로필 카드 | `buzz:sidebar/ui/SidebarProfileCard.tsx` | **완료** | `web:features/sidebar/ProfileCard.tsx`+`ProfileCard.test.tsx` |

### 1-C. 채널 · 타임라인

| # | 축 | buzz 근거 | oort 판정 | oort 근거 |
|---|---|---|---|---|
| 19 | 채널 헤더(주제·멤버·음소거) | `buzz:chat/ui/ChatHeader.tsx` | **완료** (BZ-2) | `web:features/chat/ChannelHeaderMenu.tsx`+`channelHeaderControl.ts`+`ChatShell.header.test.ts` |
| 20 | 가상화 타임라인·author 그룹핑·day divider·unread divider | `buzz:messages/ui/MessageTimeline.tsx`·`DayDivider.tsx`·`UnreadDivider.tsx` | **완료** | `web:features/timeline/Timeline.tsx`(`DayDivider`/`UnreadDivider` 임포트 L40·43), `navigation.ts` `unreadDividerIndexOf`, `model.test.ts` |
| 21 | 점프 필 **상단(안읽음으로)+하단(최신으로)** | `buzz:shared/ui/UnreadPill` | **완료** (A2) | `web:features/timeline/UnreadPill.tsx`(`direction: "up"\|"down"` 단일 컴포넌트)+`Timeline.unreadPill.test.tsx`·`UnreadPill.test.tsx` |
| 22 | 채널 빈 상태 인트로 블록 | `buzz:messages/ui/ChannelIntroBlock.tsx` | **완료** (A8) | `web:features/timeline/ChannelIntroBlock.tsx`+`channelIntro.ts`+`Timeline.intro.test.tsx`·`ChatShell.intro.test.tsx` |
| 23 | DM 인트로 아바타 스택 | `buzz:messages/ui/DirectMessageIntroAvatarStack.tsx` | **부분** | `channelIntro.ts`가 채널 인트로는 덮으나 DM 전용 아바타 스택 변형은 미확인 |
| 24 | 리액션 칩 + **누가 눌렀는지** | `buzz:messages/ui/MessageReactions.tsx` | **완료** (A1) | `web:features/timeline/ReactionChips.tsx`가 `core:features/timeline/reactionNames.ts` `formatReactionNames`/`reactionChipAccessibleName` 소비, `title`+`aria-label` 양쪽. `ReactionChips.test.tsx` |
| 25 | 메시지 액션 기본셋(답글·인용·복사·링크복사·핀·편집·삭제) | `buzz:messages/ui/MessageActionBar.tsx` | **완료** | `web:features/timeline/messageActionModel.ts` `messageActionItems` (react/reply/quote/copy/copy-link/pin/remind/edit/delete) + `MessageActions.tsx`·`MessageHoverToolbar.test.tsx` |
| 26 | 메시지 액션 확장 **mark unread / follow thread / report / spoiler / send-to-channel** | `buzz:messages/ui/MessageActionBar.tsx`("Mark unread","Follow thread","Mark as spoiler","Send to channel"), `moderation/ui/ReportMessageDialog.tsx` | **미착수** (B4) | `messageActionModel.ts` 주석이 직접 "mark unread — PUT read-state is monotone(GREATEST). Accrued." / "report — no surface. Accrued." 로 자기 고백. 코드 0건 |
| 27 | 스레드 패널 | `buzz:messages/ui/MessageThreadPanel.tsx`(+`useIndependentThreadPanel.ts`) | **부분** | `web:features/timeline/ThreadPanel.tsx` 존재·MessageRow 해부 공유. **폭 고정** — `ChatShell.tsx` L97·684가 tokens.css `thread-pane` 고정폭 참조, resize 코드 0 (A10 미착수) |
| 28 | 스레드 롤업 줄(답글 N개·마지막 시각) | `buzz:messages/ui/MessageThreadSummaryRow.tsx` | **완료** | `web:features/timeline/MessageRow.tsx` L157–162 `답글 N개 · 마지막 …`, `core:lib/api.ts` `replyCount` |
| 29 | 메시지 아바타 → 프로필 패널 | `buzz:profile/ui/UserProfilePopover.tsx` | **완료** | `web:features/timeline/MessageRow.tsx` L671–676 `openMemberProfile`, `web:features/directory/MemberProfileDialog.tsx`(+테스트) |
| 30 | 링크 프리뷰 **rich/compact/off** | `buzz:messages/ui/useComposerLinkPreviews.tsx` | **완료** (A6) | `web:features/timeline/linkPreviewPreference.ts`+`UnfurlCards.tsx`+`features/settings/LinkPreviewSection.tsx`(테스트 동반), `srv:routes/unfurl.rs` |

### 1-D. 컴포저 · 첨부 · 초안

| # | 축 | buzz 근거 | oort 판정 | oort 근거 |
|---|---|---|---|---|
| 31 | 컴포저 서식(B/I/code/link 트레이) | `buzz:messages/ui/FormattingToolbar.tsx` | **완료** (A7) | `web:features/chat/ComposerFormatTray.tsx`+`composerFormat.ts`·`composerFormatPosition.ts`·`useComposerFormat.ts`(테스트 4본). textarea 유지 = 계획대로 |
| 32 | 멘션 자동완성 | `buzz:messages/ui/MentionAutocomplete.tsx` | **완료** | `web:features/chat/MentionAutocomplete.tsx`+`features/routing/useMentionRouting.ts`, `srv:routes/agent_mentions.rs` |
| 33 | **#채널 자동완성 · :이모지 자동완성** | `buzz:messages/ui/ChannelAutocomplete.tsx`·`EmojiAutocomplete.tsx` | **미착수** | 두 이름 모두 oort 코드 0건 |
| 34 | 이모지 피커(빈도·스킨톤·검색) | `buzz:custom-emoji/ui/EmojiPicker.tsx` | **완료** | `web:features/emoji/` 전체(`EmojiPickerPanel.tsx`·`frequencyStore.ts`·`skinToneStore.ts`·`search.ts`·`gridWindow.ts`, 각 테스트 동반) |
| 35 | 첨부(드롭·붙여넣기·진행률·라이트박스) | `buzz:messages/ui/ComposerAttachments.tsx`·`ComposerUploadProgressPill.tsx` | **완료** | `web:features/attachments/useComposerDropZone.ts`·`AttachmentTray.tsx`(indeterminate→측정 진행률)·`ImageLightbox.tsx`, `srv:routes/attachments.rs` |
| 36 | **첨부 이미지 편집기 · 스포일러 마크** | `buzz:messages/ui/ComposerImageEditor.tsx`, `messages/lib/spoilerMark.ts` | **미착수** | 두 개념 모두 0건 |
| 37 | 초안 저장 + **크로스채널 초안 패널** | `buzz:messages/ui/DraftsPanel.tsx`·`DraftDetailPane.tsx` | **완료** (A5) | `web:features/drafts/DraftsRoute.tsx`·`model.ts`·`useDraftsPanel.ts`·`DraftsNavItem.tsx`(테스트 동반)+`features/chat/draftStore.ts` |
| 38 | 타이핑 표시 | `buzz:messages/useChannelTyping.ts`·`useTypingBroadcast.ts` | **완료** | `web:features/chat/TypingLine.tsx`·`typingStore.ts`·`useTyping.ts`, `srv:routes/ephemeral.rs` |
| 39 | **멀티 수신자 새 메시지 화면** | `buzz:messages/ui/NewMessageScreen.tsx`·`useNewMessageRecipients.ts` | **부분** | oort는 ⌘⇧K→`useOpenDm.ts` 1:1 DM만. 다중 수신자 조립 표면 0 |
| 40 | **커스텀 이모지**(업로드·`:name:`·워크스페이스 팔레트) | `buzz:custom-emoji/` 전체 + `messages/lib/customEmojiNode.ts` | **미착수** (B3) | `customEmoji` 검색 0건. 서버 레지스트리도 0 |
| 41 | GIF 피커 | `buzz:gifs/` | **의도적 제외** | gap-candidates 비권장: "서드파티 계약+서버 프록시 비용 대비 내부 도구 효용 중간" |

### 1-E. 검색 · 이동 · 단축키

| # | 축 | buzz 근거 | oort 판정 | oort 근거 |
|---|---|---|---|---|
| 42 | 메시지 검색(스니펫·하이라이트) | `buzz:search/ui/SearchResultItem.tsx`·`HighlightedSearchText.tsx` | **완료** | `web:features/search/SearchRoute.tsx`+`core:features/search/searchModel.ts`(`snippetSegments` 등), `srv:routes/search.rs` |
| 43 | **검색 스코프 칩(이 채널 / 전체)** | `buzz:search/ui/SearchScopeControls.tsx`("Search in …" / "Search everything" / channelType dm 분기) | **미착수** | `srv:routes/search.rs`가 `workspace_scope`만 — 채널 한정 질의 파라미터 없음. 클라도 없음 |
| 44 | ⌘K 퀵스위처 | `buzz` 상단바 검색 | **완료** | `web:app/QuickSwitcher.tsx`(cmdk, 채널·사람·설정·목적지)+`quickSwitcherSurface.test.ts` |
| 45 | 단축키 도움말 모달 | — | **완료** | `web:app/ShortcutHelpDialog.tsx`+`keyboardShortcuts.ts`(3그룹 단일 정본, 테스트 동반) |
| 46 | **단축키 설정 섹션 + mac/win 키캡 분기** | `buzz:settings/ui/KeyboardShortcutsCard.tsx`("settings-shortcuts") | **미착수** (A9) | `settingsNav.ts` `SETTINGS_SECTIONS` 14개에 shortcuts 없음. `keyboardShortcuts.ts` `keycaps`는 `["⌘K"]` 하드코딩 — 플랫폼 분기 0 |
| 47 | 메시지 딥링크(`?msg=&seq=`) | `buzz:shared/useMessageDeepLinks.ts` | **완료** | `web:features/inbox/anchor.ts`(`/c/{id}?msg=&seq=`, 소비 후 주소 정리)+`anchor.test.ts` |

### 1-F. 알림 · 프레즌스 · 상태

| # | 축 | buzz 근거 | oort 판정 | oort 근거 |
|---|---|---|---|---|
| 48 | 워크스페이스 알림 규칙(DND·멘션 예외) | `buzz:settings/ui/NotificationSettingsCard.tsx` | **완료** | `web:features/settings/NotificationRulesSection.tsx`(+테스트), `srv:routes/notification_rules.rs` |
| 49 | **데스크톱 알림 권한 상태·요청 UI** | buzz "Desktop / Requesting… / Blocked / Unavailable" | **완료** (A4 절반) | `web:features/notifications/permission.ts`(4상태)+`features/settings/DesktopNotificationGroup.tsx`(+테스트). 주석이 buzz 그룹 이식임을 명시 |
| 50 | 알림 **종류별** on/off | buzz 이벤트 종류별 | **부분** (A4 나머지) | `DesktopNotificationGroup.tsx` `DESKTOP_NOTIFICATION_KIND_ROWS` = 멘션·승인요청·나중에알림 **3종만**. buzz의 DM/스레드답글 축 없음 |
| 51 | **알림음 · 배지** | `buzz:settings/ui/SoundPicker.tsx`, `NotificationSettingsCard` "Alert sounds"/"Badges" | **미착수** | `DesktopNotificationGroup.tsx` 주석이 "Sound pickers are out of scope" 로 명시적 미착수. 배지 코드 0건 |
| 52 | 프레즌스(auto/away/dnd) | `buzz:presence/ui/PresenceBadge.tsx` | **완료** | `web:features/sidebar/PresenceControl.tsx`+`presenceIndicators.test.ts`, `srv:routes/presence.rs` |
| 53 | **커스텀 상태**(이모지+텍스트+프리셋) | `buzz:user-status/ui/SetStatusDialog.tsx`·`StatusEmoji.tsx` | **완료** (B2) | `web:features/sidebar/SetStatusDialog.tsx`·`CustomStatusMark.tsx`·`useCustomStatusView.ts`(테스트 3본), `srv:dto.rs` `status_emoji`/`status_text` + `OptionalPatch`(ADR-0176) |
| 54 | **메시지 리마인더**(나중에 알림·스누즈·목록) | `buzz:reminders/ui/RemindMeLaterDialog.tsx`·`SnoozeMenu.tsx`·`RemindersPanel.tsx` | **완료** (B1) | `web:features/reminders/` 전체(`RemindDialog.tsx`·`RemindersPanel.tsx`·`ReminderDueWatcher.tsx`·`watermark.ts`·`dueNotify.ts`, 테스트 6본), `srv:routes/reminders.rs`(create/list/update/delete + 에이전트 거부 테스트) |
| 55 | 통합 인박스 | `buzz:home/ui/InboxListPane.tsx`·`InboxFilterMenu.tsx`·`useResizableInboxListWidth.ts` | **부분** | `web:features/inbox/InboxRoute.tsx`+`useInbox.ts`+`approvalsPanel.ts`(승인 중심). buzz의 필터 메뉴·리스트 폭 리사이즈 없음 |

### 1-G. 허들 · 프로필 · 설정 · 운영

| # | 축 | buzz 근거 | oort 판정 | oort 근거 |
|---|---|---|---|---|
| 56 | 허들 시작/참가/헤더 컨트롤 | `buzz:huddle/components/HuddleBar.tsx`·`HuddleRoomHeader.tsx` | **완료** | `web:features/huddles/HuddleHeaderControl.tsx`+`useHuddle.ts`+`huddleRuntime.ts`, `srv:routes/huddles.rs` |
| 57 | **마이크 디바이스 선택 + 게인** | `buzz:huddle/components/MicControls.tsx` | **완료** (A3) | `web:features/huddles/HuddleMicMenu.tsx`·`micDeviceStore.ts`·`micGain.ts`·`useAudioInputDevices.ts`(테스트 4본) |
| 58 | 참가자 목록 패널 | `buzz:huddle/components/ParticipantList.tsx`+`useHuddleParticipantRoster.ts` | **부분** | oort는 헤더 Live 칩의 요약 문장만(`HuddleHeaderControl.tsx` `huddleParticipantSummary`, 모바일은 숫자). 목록 패널 없음 |
| 59 | 허들 전사(transcript) 인트로 | `buzz:huddle/components/HuddleTranscriptIntro.tsx` | **미확인** | oort `huddleTurnRewrite.ts`가 턴을 다루나 전사 표면 유무를 이번 실사로 확정하지 못함 |
| 60 | 화면공유·비디오 | `buzz` 미확인(voice 중심 crate) | **미확인** | oort `web:features/work/DisplayObserver.tsx`는 에이전트 화면 관찰이지 사람 화면공유가 아님. 양쪽 다 근거 부족 |
| 61 | 프로필 편집(이름·아바타) | `buzz:profile/ui/ProfileAvatarEditor.tsx` 외 20+ | **완료** | `web:features/settings/ProfileSection.tsx`(+테스트), `srv:routes/self_profile.rs`·`workspace_avatar.rs` |
| 62 | 애니메이션 아바타 캡처(카메라) | `buzz:profile/ui/AnimatedAvatarCapture.tsx` 외 | **미착수** | 대응물 0. (제품 방향 판단 필요 — 비권장 목록에는 없음) |
| 63 | 멤버 디렉터리·역할 변경 | `buzz:community-members/` | **완료** | `web:features/directory/DirectoryRoute.tsx`·`MemberRow.tsx`·`useChangeWorkspaceRole.ts`, `srv:routes/roster.rs`·`member_lifecycle.rs` |
| 64 | 설정 전면(그룹·네비·포커스) | `buzz:settings/ui/SettingsScreen.tsx`·`SettingsPanels.tsx` | **완료** (BZ-4) | `web:features/settings/settingsNav.ts`(3그룹 14섹션)+`SettingsRoute.tsx`+`settingsFocus.ts`(테스트 동반) |
| 65 | 테마 라이트/다크/시스템 | `buzz:settings/ui/AppearanceSettingsControls.tsx` | **완료** | `web:features/settings/AppearanceSection.tsx`+`design/theme.ts` |
| 66 | **외양/액센트 커스터마이즈** | `buzz:app/BuzzThemeSurfaces.tsx`·`ThemeGrainientBackground.tsx` | **미착수(머지 대기)** | `AppearanceSection.tsx`는 light/dark/system 3값뿐. BZ-5a = PR #1922 미머지(track/uxui 로그에 없음) |
| 67 | 업데이트 체커 | `buzz:settings/UpdateChecker.tsx`·`UpdateIndicator.tsx` | **완료** | `web:features/updates/UpdateSection.tsx`·`UpdateBadge.tsx`·`UpdateNotice.tsx`(+테스트) |
| 68 | **인앱 피드백 다이얼로그** | `buzz:settings/ui/SendFeedbackDialog.tsx`+`hooks/useSendFeedback.ts` | **미착수** (B5) | 검색 0건 |
| 69 | **모더레이션**(신고·타임아웃·큐) | `buzz:moderation/ui/ReportMessageDialog.tsx`·`TimeoutDurationSubmenu.tsx`·`ComposerTimeoutBanner.tsx`, `settings/ui/ModerationQueueCard.tsx` | **미착수** | oort는 role 기반 권한(admin/owner)만. 모더레이션 개념 0건 |
| 70 | 절전 방지 / 모바일 페어링 / 암호화 백업 | `buzz:settings/ui/PreventSleepSettingsCard.tsx`·`MobilePairingCard.tsx`·`EncryptedBackupCreator.tsx` | **미착수 / 제외** | 페어링·암호화백업은 nostr 키 모델 파생(제외 타당). **절전 방지는 허들 있는 제품에서 순수 격차** |
| 71 | 접근성(포커스 링·로빙 tabindex·터치 분기) | buzz 산발 | **완료** | `web:features/timeline/rowFocus.ts`, `sidebarSectionModel.ts`, `design/focusRing.test.ts`, `features/emoji/useHoverNone.ts` |

### 1-H. buzz 고유 제품축 (패리티 대상 아님 — 기록만)

`forum/`(포럼 뷰·포스트 카드) · `pulse/`(마이크로블로그) · `projects/`(212파일, 이슈/브랜치/할당) · `terminal/`(내장 터미널) · `mesh-compute/`(연산 공유) · `workflows/` · `agent-memory/` · `local-archive/`·`identity-archive/` · `channel-templates/`.
→ Pulse·Local archive·Channel templates는 gap-candidates 비권장에 사유 기록됨. **나머지 6종은 어느 리서치에도 판정이 없다**(§3 참조).

---

## §2. gap-candidates 15후보 소화율

**A군 10 중 6 완료 · 1 부분 · 3 미착수. B군 5 중 2 완료 · 3 미착수. 총 15 중 8 완료(53%) · 1 부분 · 6 미착수.**

| # | 후보 | 판정 | 근거 |
|---|---|---|---|
| A1 | 리액션 "누가 눌렀는지" 툴팁 | **완료** | `core:features/timeline/reactionNames.ts` + `web:features/timeline/ReactionChips.tsx`(title/aria-label 양쪽) + `ReactionChips.test.tsx` |
| A2 | 상단 "↑ N개 안읽음" 점프 필 | **완료** | `web:features/timeline/UnreadPill.tsx` direction 단일 컴포넌트 + `Timeline.unreadPill.test.tsx` |
| A3 | 허들 마이크 디바이스 선택+게인 | **완료** | `web:features/huddles/micDeviceStore.ts`·`micGain.ts`·`useAudioInputDevices.ts`·`HuddleMicMenu.tsx` (테스트 4본) |
| A4 | 알림 설정 세분화 | **부분** | 권한 상태·요청 UI = **완료**(`permission.ts`+`DesktopNotificationGroup.tsx`). 종류별 토글은 3종(멘션/승인/리마인더)뿐 — DM·스레드답글 없음. **알림음 명시적 미착수**(코드 주석 "Sound pickers are out of scope") |
| A5 | 크로스채널 초안 패널 | **완료** | `web:features/drafts/` 6파일(테스트 동반), PR #1906 |
| A6 | 링크 프리뷰 Rich/Compact/Off | **완료** | `web:features/timeline/linkPreviewPreference.ts`+`features/settings/LinkPreviewSection.tsx`(테스트), PR #1913 |
| A7 | 컴포저 서식 최소셋 | **완료** | `web:features/chat/ComposerFormatTray.tsx`+`composerFormat*.ts` 3본(테스트 4본), PR #1909 |
| A8 | 채널 빈 상태 인트로 블록 | **완료** | `web:features/timeline/ChannelIntroBlock.tsx`+`channelIntro.ts`(가상화 leading row), PR #1914 |
| A9 | 단축키 플랫폼 표기 + 설정 섹션 | **미착수** | `settingsNav.ts`에 shortcuts 섹션 없음, `keyboardShortcuts.ts` keycaps 하드코딩 `["⌘K"]` |
| A10 | 스레드 패널 폭 리사이즈 | **미착수** | `ThreadPanel.tsx`·`ChatShell.tsx`에 resize/drag 0건, tokens.css `thread-pane` 고정폭 |
| B1 | 메시지 리마인더 | **완료** | 클라 `web:features/reminders/` 11파일 + 서버 `srv:routes/reminders.rs` CRUD, PR #1918 |
| B2 | 사용자 커스텀 상태 | **완료** | 클라 `web:features/sidebar/SetStatusDialog.tsx`·`CustomStatusMark.tsx` + 서버 `dto.rs` status_emoji/status_text(ADR-0176), PR #1920 |
| B3 | 커스텀 이모지 | **미착수** | 클라·서버 모두 0건 |
| B4 | 메시지 ⋯ 메뉴 확장 | **미착수** | `messageActionModel.ts` 주석이 mark-unread/report를 "Accrued"로 자기 기록. follow-thread도 0 |
| B5 | 인앱 피드백 다이얼로그 | **미착수** | 0건 |

**비권장 5 준수 확인**: Pulse·Local archive·Channel templates·스레드 Split/Focus·GIF picker — 전부 oort에 미유입. 이탈 없음.

---

## §3. 사각지대 — buzz에 있는데 우리 리서치가 **아예 다루지 않은** 축

gap-candidates(2026-08-29)는 "이미 처리된 BZ-1~4·6a·ADR-0174 영역 제외"를 전제로 15후보만 뽑았고, 8/10 감사 A~E는 UI가 아니었다. 그 사이로 빠진 것들:

### S1. 사이드바 조직화 문법 전체 (가장 큰 구멍)
buzz는 **커스텀 섹션 생성/이름변경/아이콘, 채널 별표, 섹션 이동, A–Z/Recent 정렬, DnD 재정렬**을 갖는다(`buzz:sidebar/ui/CustomChannelSection.tsx`·`ChannelSectionDialogs.tsx`·`SidebarDnd.tsx`·`ChannelContextMenu.tsx`). oort는 `SidebarSectionId = "channels" | "dms"` 고정 2종이 전부다. BZ-1이 "접기"만 가져왔기 때문에 **접을 대상 자체를 사용자가 만들 수 없다**는 구조 결함이 후보 목록에 아예 등장하지 않았다.

### S2. 사이드바 행 우클릭 컨텍스트 메뉴 부재
oort의 채널 액션은 **헤더 메뉴에만** 있다(`ChannelHeaderMenu.tsx`). buzz는 사이드바 행 우클릭에 11항목. "채널을 열지 않고 음소거/읽음처리"라는 동작 자체가 oort에 없다.

### S3. 채널 브라우저(공개 채널 둘러보기)
`buzz:channels/openChannelDirectory.ts` + "Browse channels". oort는 ⌘K가 **이미 받아 둔 목록의 클라 필터**뿐(`QuickSwitcher.tsx` 주석이 그렇게 명시). 즉 **내가 아직 안 들어간 채널을 발견할 경로가 0**이다. 워크스페이스가 커지는 순간 즉시 아프다.

### S4. 검색 스코프
`buzz:search/ui/SearchScopeControls.tsx`("Search in {채널}" / "Search everything" / DM 분기). oort `srv:routes/search.rs`는 `workspace_scope`만 받는다 — 서버 계약부터 채널 한정 검색이 불가능하다.

### S5. 컴포저 `#채널` / `:이모지` 자동완성
buzz는 3종 자동완성(멘션·채널·이모지). oort는 멘션 1종. `#`로 채널 링크를 거는 문법 자체가 없다(`core`에 channelLink 대응물 미확인).

### S6. 알림음·앱 배지
`buzz:settings/ui/SoundPicker.tsx`, "Alert sounds"/"Badges". oort는 코드 주석으로 스스로 out of scope 선언. **"소리 없는 메신저"**는 데스크톱 제품에서 눈에 띄는 결손이다.

### S7. 모더레이션 전면
신고 다이얼로그·타임아웃 서브메뉴·컴포저 타임아웃 배너·모더레이션 큐 카드(`buzz:moderation/`+`settings/ui/ModerationQueueCard.tsx`). gap-candidates는 B4 안에 "report" 한 항목으로만 스쳤다. 워크스페이스 오너 관점 운영 도구가 통째로 비어 있다.

### S8. 멀티 수신자 새 메시지 화면
`buzz:messages/ui/NewMessageScreen.tsx`+`useNewMessageRecipients.ts`+`SelectedRecipientChip.tsx`. oort는 1:1 DM만.

### S9. 스포일러 / 이미지 편집기
`spoilerMark.ts`·"Mark as spoiler"·`ComposerImageEditor.tsx`.

### S10. 인박스 필터 메뉴 + 리스트 폭 리사이즈
`buzz:home/ui/InboxFilterMenu.tsx`, `useResizableInboxListWidth.ts`. oort 인박스는 승인 중심 단일 목록.

### S11. 절전 방지(PreventSleep)
`buzz:settings/ui/PreventSleepSettingsCard.tsx`. 허들·에이전트 장시간 실행을 가진 제품에서 실용 격차.

### S12. 채널 활동 팝오버 / 사이드바 안읽음 점프 버튼
`ChannelActivityPopover.tsx`·`MoreUnreadButton.tsx`. oort는 키보드 ⌥↑↓만 있고 **보이는 경로가 없다**(발견 가능성 0).

### S13. 웰컴 킥오프 스테이지
온보딩 리서치가 "**최대 이식 가치 = D(웰컴 킥오프)**"라고 스스로 결론냈는데, gap-candidates 15후보에는 들어가지 않았고 랜딩도 안 됐다. 리서치 간 인계 누락.

### S14. 판정 없는 buzz 제품축 6종
`forum/` · `projects/` · `terminal/` · `mesh-compute/` · `workflows/` · `agent-memory/`. 비권장 목록에도 없고 후보에도 없다 — **채택/제외 판정 자체가 존재하지 않는다.** 특히 `agent-memory/ui/MemorySection.tsx`와 `workflows/`는 oort의 agent-native 방향과 정면으로 겹치는데 대조된 적이 없다.

---

## §4. "지금 가져오면 좋은" 우선순위 — 토대성 순

정렬 기준은 성재 지시대로 **토대성**(구조·상호작용 문법을 먼저 세워 두면 이후 디테일 수정이 값싸지는가)이다. 기능 하나의 효용이 아니라 "나중에 다시 뜯을 확률"이 낮은 순.

| 순위 | 항목 | 왜 (토대성) | 규모 | 선행 의존 |
|---|---|---|---|---|
| **1** | **사이드바 조직화 문법**(커스텀 섹션 CRUD + 섹션 이동 + 별표 + 정렬) — §3 S1 | 사이드바는 앱에서 가장 오래 사는 구조다. 지금 `"channels"\|"dms"` 하드코딩 2종 위에 BZ-1 접기·unread 집계·hover 액션·⌥↑↓ 순회가 **전부 이미 올라가 있다**. 섹션이 데이터가 되는 순간 그 넷을 전부 다시 만져야 한다 — 늦을수록 비싸진다. 반대로 지금 세워 두면 성재가 이름·아이콘·순서를 마음껏 고쳐도 구조는 안 흔들린다 | **L** (클라 M + 서버 S: 섹션 테이블·멤버별 채널 배치) | 없음(ADR 1본 필요 — 섹션 소유가 멤버별인지 워크스페이스인지) |
| **2** | **사이드바 행 컨텍스트 메뉴** — §3 S2 | "행을 우클릭한다"는 문법이 없으면 이후 모든 채널 액션(별표·섹션 이동·읽음처리·아카이브)이 갈 곳이 없다. 1번의 **전달 표면**이라 함께 서야 하고, 이미 있는 `ChannelHeaderMenu.tsx` 항목을 재사용하므로 신규 로직은 얇다 | **S** | 없음 (1번과 짝) |
| **3** | **메시지 ⋯ 확장: mark unread + follow thread** (B4) | 읽음 상태를 사용자가 되돌릴 수 있는가는 메신저의 **읽기 모델 자체**다. 지금 `read_state`가 monotone(GREATEST)이라 클라만으로는 영원히 못 한다 — 서버 계약을 언제 풀든 한 번은 뜯어야 하고, 뒤로 갈수록 그 위에 쌓인 unread 집계(사이드바 배지·⌥↑↓·UnreadPill·UnreadDivider)가 늘어난다. 지금이 가장 싸다 | **M** (서버 S: forced-unread 저장, 클라 M) | `srv:routes/read_state.rs` monotone 해제 ADR |
| **4** | **검색 스코프 + 채널 브라우저** — §3 S3·S4 | 둘 다 "이 워크스페이스에서 무언가를 **찾는** 방법"이라는 한 문법의 앞뒤다. `srv:routes/search.rs`가 workspace 스코프만 받는 지금 구조는 채널 필터가 붙는 순간 질의·페이징·빈결과 카피가 전부 바뀐다. 채널 브라우저는 "안 들어간 채널 목록" API가 서는 순간 ⌘K·빈상태 인트로·초대 흐름이 전부 그걸 재사용한다 | **M** (서버 M + 클라 M) | 없음 |
| **5** | **컴포저 3종 자동완성 통일(`@`/`#`/`:`)** — §3 S5 | 지금 `@` 하나만 있고 트리거·리스트·키보드 처리가 그 하나에 붙어 있다. `#`·`:`를 나중에 각자 붙이면 **트리거 파서가 세 벌**이 된다(buzz도 세 파일로 갈라져 있다 — 그 실수를 안 밟을 기회). A7 서식 트레이가 이미 선택/커서 위치 유틸(`composerFormatPosition.ts`)을 만들어 뒀으니 지금이 합류 지점 | **M** | A7(완료) |
| 6 | 알림 종류 세분화 + 알림음/배지 (A4 잔여 + §3 S6) | 권한 UI라는 어려운 절반은 이미 랜딩됐다. 남은 건 종류 축 확장과 사운드 — 토대는 낮지만 "왜 알림이 안 오지"의 마지막 조각 | S~M | A4 완료분 |
| 7 | 스레드 패널 폭 리사이즈 (A10) | 고정폭 `thread-pane` 토큰을 사용자 값으로 여는 일. 늦게 해도 비용이 안 커지지만 체감이 크다 | S | 없음 |
| 8 | 단축키 설정 섹션 + 플랫폼 키캡 (A9) | `keyboardShortcuts.ts`가 이미 단일 정본이라 keycaps만 플랫폼 분기하면 모달·설정·툴팁이 동시에 맞는다. 값싼 정합 작업 | S | 없음 |
| 9 | 웰컴 킥오프 스테이지 — §3 S13 | 온보딩 리서치가 스스로 최대 이식가치로 꼽은 항목. agent-native 정체성의 첫인상. 다만 기존 에이전트 인프라 위 조립이라 구조 리스크는 낮음 | M | BZ-6a(완료), 에이전트 멘션 |
| 10 | 모더레이션 최소셋(신고 → 큐) — §3 S7 | 오너 운영 도구. 지금 없어도 안 깨지지만 공개 이후엔 필수. 토대성 중간 | M (서버 M) | ADR 필요 |

**규모 밖 / 별도 결정 필요**: 커스텀 이모지(B3 — 효용 최상·비용 최대, 별도 결재), BZ-5a 외양 커스터마이즈(#1922 **머지 대기** — 코드는 이미 있음, 성재 확정만 남음), buzz 제품축 6종(§3 S14 — 채택/제외 판정부터 필요).

---

## 부록 — 판정 방법과 한계
- 전 판정은 파일 존재 + 내용 열람 기준. "완료"는 구현 파일 + 동반 테스트(`*.test.ts(x)`)를 함께 확인한 경우에만 붙였다.
- 서버 판정은 `~/projects/momo-tracks/engine` 의 `server-rust/bins/momo-server/src/routes/` 실목록(52개)과 `dto.rs` 실사 기준.
- **미확인 2건**: #59 허들 전사 표면, #60 사람 화면공유 — 양쪽 코드에서 확정 근거를 못 만들어 판정하지 않았다.
- buzz `web/`는 메신저가 아니라 repos/invite 앱이다. 메신저 클라이언트 정본은 `desktop/`(Tauri+React, oort와 동일 스택)이라 전 대조를 그쪽으로 했다.
