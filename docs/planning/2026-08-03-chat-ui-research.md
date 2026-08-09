# 채팅 UI 정밀 분석 — Mattermost 모바일 · buzz → momo 적용안 (goal UX-R1)

작성 2026-08-03 · 리서치 worker · **커밋 금지 산출물**

읽은 것(전부 소스, **실행·설치·빌드 없음**):

| 레포 | 무엇 | 왜 |
|---|---|---|
| `mattermost/mattermost-mobile` | RN 앱 전체 (`app/`) | **우리와 같은 스택** — 같은 `FlatList`, 같은 `TextInput`, 같은 키보드 문제 |
| `block/buzz` — `mobile/lib` | Flutter 앱 | 폰 UX 판단(제스처·키보드·밀도)은 스택 무관하게 참고 가능 |
| `block/buzz` — `desktop/src`, `crates/`, `schema/`, `*.md` | Tauri/React 클라 + Rust 서버 + 스키마 | **에이전트가 1급**인 제품의 프로토콜·데이터 모델 |
| 우리 것 | `clients/mobile/src/features/conversation/*`, `packages/momo-core/src/features/timeline/*`, `schema_v0.sql` | 대조 기준 |

인용은 `파일:줄`. **buzz는 모바일(Flutter)과 데스크톱(React)이 서로 다르게 구현된 곳이 많아 어느 쪽인지 매번 밝힌다.** 확인하지 못한 것은 §5에 **확인 못 함**으로 적었다.

---

## 1. 요지 — 우리 채팅이 힘든 이유 top 3

**① 메시지를 탭해도 아무 일도 일어나지 않는다. 모든 행위가 보이지 않는 450ms 롱프레스 뒤에 있다.**
`MessageRow.tsx:707`이 그렇게 적어 두었다 — *"No `onPress`: a tap on a message does nothing yet"*. 유일한 진입점은 롱프레스이고 임계값은 `packages/momo-core/src/features/timeline/longPressModel.ts:31` `LONG_PRESS_MS = 450`. 제스처가 보이지 않으니 그것을 가르치려고 컴포저 위에 컴포넌트를 하나 더 달아야 했다(`LongPressHint.tsx:28` — `'메시지를 길게 누르면 답글·반응·고치기'`).
두 레퍼런스 **모두** 탭에 뜻을 준다. Mattermost `post.tsx:458-460` — `onPress={handlePress}` / `onLongPress={showPostOptions}` / **`delayLongPress={200}`**, 탭은 `handlePostPress`(`post.tsx:222-223` `fetchAndSwitchToThread`)로 스레드를 연다. buzz 모바일 `message_bubble.dart:82` `onTap` → `ThreadDetailPage` push, `:96` `onLongPress` → `showMessageActions`, 그리고 `:80`에 주석으로 못 박아 두었다: *"Tap opens the thread; long-press still opens the action sheet."*
즉 **우리만 탭이 죽어 있고, 유일한 문은 남들보다 2.25배 오래 눌러야 열린다.**

**② 키보드가 올라오면 짧은 대화 — 즉 스레드 — 가 화면 위로 밀려 사라진다.** (성재: *"스레드에서도 채팅을 하면 위에 숨겨져 있어서 채팅 닫아야 보이더라."*)
두 사실의 곱이다.
- `ConversationLayout.tsx:64-72`가 설계를 적어 두었다: 팬은 **줄어들지 않고 통째로 올라가며**, *"what is given up is the top of the viewport"*. 올리는 양은 `keyboardPane.tsx:26-29` — *"lifts by `keyboardHeight - bottomInset`"*, 그 높이는 이 레포 자신이 335px로 기록해 두었다(`ConversationLayout.tsx:29`).
- 그런데 `Timeline`의 FlatList(`Timeline.tsx:754-811`)에는 `contentContainerStyle`이 없다 → 콘텐츠가 뷰포트보다 **짧으면 뷰포트 위쪽에 붙는다**. 스레드는 구조적으로 짧다(`ThreadPanel.tsx:103` — `messages = [liveRoot, ...replies]`).

그래서 키보드가 올라오면 루트와 답글 몇 줄이 클립(`ConversationLayout.tsx:116,132` `overflow:'hidden'`) 위로 통째로 빠져나가고 그 아래는 빈 띠가 된다. 키보드를 닫아야 다시 보인다 — 성재가 본 그대로다.
**셋 중 리스트를 통째로 미는 것은 우리뿐이다.** Mattermost는 리스트 높이를 고정한 채 `contentInset.top`을 키보드 높이만큼 준다(`post_list.tsx:530-539`, `useAnimatedProps`이므로 UI 스레드에서 돈다 — 레이아웃 프롭이 아니다). buzz는 리스트를 `Column`의 `Expanded`로 두어(`thread_detail_page.dart:244-247`) Flutter의 `Scaffold` 리사이즈에 맡긴다. 두 방식 다 **뷰포트가 줄어들 뿐 콘텐츠가 화면 밖으로 나가지 않는다.**

**③ 키보드를 닫는 길이 사실상 하나뿐이고, 그 하나가 짧은 대화에서는 작동하지 않는다.** (성재: *"채팅창 여는 건 성공했는데 다시 닫을 때 어떻게 해야 하는지 모르겠다."*)
우리 앱의 유일한 경로는 `Timeline.tsx:804` `keyboardDismissMode="interactive"`다. 이건 **리스트를 키보드 쪽으로 드래그**해야 걸리므로 스크롤할 콘텐츠가 없으면(=스레드, 새 채널) 아예 발동하지 않는다. 명시 버튼도, 바깥 탭도, 헤더 탭도 없다.
Mattermost는 셋을 겹친다: 같은 `keyboardDismissMode='interactive'`(`post_list.tsx:564`) + **메시지 탭 시 `dismissKeyboard()`**(`post.tsx:239`, 구현 `utils/keyboard.ts:15-22`) + 화면 전환 전 `blurAndDismissKeyboard()`(`post.tsx:218`, `keyboard_state/index.tsx:310-319`).
buzz 모바일은 전용 위젯을 만들어 **리스트와 컴포저 바 양쪽**에 붙였다 — `shared/widgets/keyboard_dismiss_on_drag.dart:8` `keyboardDismissDragThreshold = 48.0`, 리스트 적용 `message_list.dart:251`, 컴포저 적용 `compose_bar/layout.dart:262-306`. 컴포저 쪽은 제스처 아레나를 피하려고 raw `Listener`를 쓰고, **드래그가 텍스트 필드 안에서 시작하면 빠진다**(`layout.dart:275-283`가 `RenderEditable` 히트테스트, `:293`이 그 경우 return).

> 덧: **밀도는 문제가 아니다.** 우리 행은 `MessageRow.tsx:1025` `paddingVertical: 3`, 본문 16/22(`:1048`). Mattermost는 본문 15/20(`body.tsx:79-83`)에 헤더 `marginTop: 10`(`header.tsx:63-66`), 연속 행 블록 `marginBottom: 10`(`post.tsx:94-99`). **우리가 더 빽빽하다.** 차이는 여백이 아니라 **왼쪽 기둥**이다 — 세 클라이언트 모두 아바타 열을 두고 연속 메시지에서 그 폭을 빈칸으로 남긴다(MM `post.tsx:97` `marginLeft: PROFILE_PICTURE_SIZE`=32(`constants/view.ts:11`); buzz 모바일 `message_bubble.dart:124` `SizedBox(width: messageAvatarSize)`=42(`shared/theme/message_typography.dart:8`); buzz 데스크톱은 그 자리에 **호버 시 시각을 띄운다** `MessageRow.tsx:434-449`). 우리에겐 아바타가 없고(`MessageRow.tsx:146-187`의 `Author`는 이름·핸들·배지·시각만), 연속 행은 들여쓰기도 앵커도 없이 왼쪽 끝에서 시작한다.

---

## 2. 항목별 비교표

### 2-1. 메시지 행 자체

| | Mattermost 모바일 (RN) | buzz (Flutter 모바일 / React 데스크톱) | **momo 현재** |
|---|---|---|---|
| 형태 | 평행 행, 아바타 왼쪽 열 + 본문 오른쪽 열 (`post.tsx:472-478`) | 평행 행, 동일 구조. 말풍선 없음·좌우 정렬 없음 — 모바일 `message_bubble.dart:112-124`(`currentPubkey`는 권한 판정에만 `:32-35`) | 평행 행, **아바타 열 없음** (`MessageRow.tsx:675-705`) |
| 연속 묶기 창 | **5분** — `Post.POST_COLLAPSE_TIMEOUT`(`constants/post.ts:62` `toMilliseconds({minutes: 5})`), 규칙 `utils/post/index.ts:25-54` | 모바일 **5분** — `(createdAt - prev.createdAt) > 300` 리터럴(`message_list.dart:295-302`). 데스크톱 **10분** — `MESSAGE_GROUPING_WINDOW_SECONDS = 10 * 60`(`messageGrouping.ts:12`). **두 클라가 서로 다르다** | **5분** — `AUTHOR_GROUP_WINDOW_MS = 300_000`(`model.ts:273`), 규칙 `model.ts:289-299` |
| 묶기를 끊는 추가 조건 | 시스템 메시지, webhook, **봇**(`post/index.ts:130` `!user?.isBot`), AI 생성 직후(`utils/post/index.ts:26-29`), 번역 상태 변화(`:45-50`) | 모바일: 시스템 행, 날짜 구분선, **첨부가 있으면 끊는다**(`message_list.dart:296-297`). 데스크톱: 날짜 구분선(`timelineItems.ts:199-200`), 미읽음 구분선(`:207-210`), 시스템 메시지(`:216-218`), **전송 중인 메시지**(`:239-241`) | 날짜 경계, 그리고 구분선이 앞에 오면(`model.ts:687` `dividerAbove`). **에이전트 예외 없음 — 사람과 똑같이 묶인다** |
| 묶였을 때 생략 | 아바타(`PROFILE_PICTURE_SIZE`만큼 빈칸, `post.tsx:97,323`), 헤더 전체 | 모바일: 아바타(42px 빈칸 `:124`), 헤더 전체 → **시각도 사라진다**. 패딩 `Grid.xs`(16) → `Grid.xxs`(8)(`:68`,`:109-110`, 값은 `shared/theme/grid.dart:9,15`). 데스크톱: 헤더 생략하되 **아바타 자리에 호버 시 시각을 되살린다**(`MessageRow.tsx:434-449` `opacity-0 … group-hover/message:opacity-100`) | 헤더 전체(`MessageRow.tsx:714-720`) → **시각도 사라진다**. 상단 패딩 12→0(`:1025,1029`) |
| 시각 위치 | 헤더 안, 이름·태그 뒤 (`header.tsx:153-159`) | 헤더 안 (모바일 `shared/widgets/message_author_meta.dart`) | 헤더 **맨 오른쪽**, `hh:mm` 24시 (`MessageRow.tsx:184`, 포맷 `:82-87`) |
| 전송중 / 실패 | 전송중 = 행 전체 `opacity: 0.5`(`post.tsx:109,302`); 10초 뒤 실패로 전환(`constants/post.ts:57` `POST_TIME_TO_FAIL = 10s`, 타이머 `post.tsx:265-279`); 실패 시 `body/failed` | 모바일: **실패 표시가 없다** — 실패하면 낙관 삽입 행을 **지우고** rethrow(`send_message_provider.dart` try/catch → `_removeLocalMessage`). 데스크톱: 전송 중이면 헤더를 유지해 "Sending…"을 시각 옆에 둔다(`MessageRow.tsx:148-150`) | 전송중 = 본문 흐림 + `'전송 중'`(`MessageRow.tsx:995,1013-1015`), 실패 = `'전송 실패'` + 44px `'다시 보내기'`(`:838-852`,`:1080-1096`). **셋 중 가장 낫다** |
| 리스트 방향 | **`inverted={true}`**(`post_list.tsx:583`) + `maintainVisibleContentPosition {minIndexForVisible:0, autoscrollToTopThreshold:60}`(`config.ts:6-15`). 이걸 안고 가려고 RN 코어를 패치한다(`patches/react-native+0.83.9.patch`) | 모바일 채널은 `reverse: true`(`message_list.dart:254`, `ScrollablePositionedList`). **모바일 스레드는 정방향**, **데스크톱은 전부 정방향** — `virtua`의 `VList`이고 `reverse`/`column-reverse`가 없다(`TimelineMessageList.tsx:569-580`). 프리펜드 위치 보존은 `shift={isPrepend}` 프롭 | **정방향**(실측 근거 `Timeline.tsx:36-48`) + `maintainVisibleContentPosition {minIndexForVisible:0}`(`:218,768-770`) |
| 짧은 콘텐츠 정렬 | inverted → 자동 하단 정렬 | 모바일 채널은 하단(reverse). **모바일 스레드는 상단이고 그게 의도적이다** — `thread_detail_page.dart:253-256`: *"The old reversed list bottom-anchored the content, **which jammed the head against the composer** whenever a thread had only a handful of replies."* | **상단 정렬**(FlatList 기본). §1 ②의 절반 |

**우리와 무엇이 다른가**
1. **아바타 열이 없다.** 셋 중 우리만.
2. **에이전트를 사람과 똑같이 묶는다.** Mattermost는 봇을 **명시적으로 묶지 않아**(`post/index.ts:130`) 봇이 말할 때마다 헤더가 다시 뜬다. 에이전트가 1급인 우리 제품에서 에이전트 5줄이 헤더 없이 붙으면 누가 말하는지가 사라진다.
3. **전송 상태 표현은 우리가 가장 충실하다.** buzz 모바일은 실패를 지워 버리고, Mattermost는 재전송 어포던스가 약하다.
4. **`shift`(buzz 데스크톱) ≡ `maintainVisibleContentPosition`(우리) ≡ `firstItemIndex`(웹 virtuoso).** 정방향 + 프리펜드 보정이라는 우리 조합에 buzz 데스크톱이 독립적으로 같은 결론으로 도달했다 — **정방향 선택은 검증됐다.**

### 2-2. 스레드

| | Mattermost | buzz | **momo 현재** |
|---|---|---|---|
| 목록에서 알리는 법 | 루트 행 하단 `Footer`: **참여자 아바타 스택 + "N replies" + Follow/Following 버튼**, `minHeight: 40`(`footer/footer.tsx:96-180`, 아바타 `:161-172`). 미읽음이면 `UnreadDot`(`post.tsx:443-447`) | 모바일 `_ThreadSummaryRow`(`system_rows.dart:477`): 본문 열에 맞춰 들여쓰기(`:518` `left: messageAvatarSize + gap`), 참여자 아바타 겹침 스택(`:532`), `"N replies"`(`:550`) + `"last reply …"`(`:566`). 데스크톱 `MessageThreadSummaryRow.tsx:246,261-263` 동일 구성 + aria `"View thread with N replies, last reply …"`(`:99-100`) | 루트 행 tail에 텍스트 링크 한 줄 `'답글 N개 · 마지막 3시간 전'`(`MessageRow.tsx:805-834`). 아바타 없음, 미읽음 없음. **다만 카운트는 서버 롤업과 로컬 롤업의 최댓값**이라 내가 단 답글이 즉시 반영된다(`threadContext.ts:120-139`) — 둘 다 안 하는 좋은 처리 |
| 여는 법 | ① **본문 탭**(`post.tsx:458`→`:222-223`) ② `Footer` 탭 ③ 롱프레스 시트 `ReplyOption`(`post_options.tsx:114`) | ① **본문 탭**(모바일 `message_bubble.dart:82`) ② 요약 행 탭 ③ 롱프레스 시트 `Reply` ④ 데스크톱은 액션 바 `aria-label="Reply"`(`MessageActionBar.tsx:520`) | **롤업 링크 탭 + 롱프레스 시트의 `답글`** 둘뿐. 본문 탭은 죽어 있다(`MessageRow.tsx:706-713`). 다만 답글 행의 `↳ ○○님에게 답글` 표식도 탭하면 그 스레드로 간다(`MessageRow.tsx:726-739`) — **우리만 있는 것** |
| 스레드 화면 구조 | **네비게이션 스택의 진짜 화면**(`Screens.THREAD`, `screens/thread/thread.tsx:104-131`). 리스트는 채널과 **같은 `PostList`**를 재사용하고 루트를 배열 끝에 붙인다(inverted라 맨 위, `thread_post_list.tsx` `threadPosts = [...posts, rootPost]`). 루트와 답글 사이에 `ThreadOverview` — 상하 1px 테두리 + "N replies" + 저장/⋯(`thread_overview.tsx:29-55,94-132`) | 모바일: 전용 페이지 `ThreadDetailPage`, 인덱스 0이 헤드(`thread_detail_page.dart:262` `itemCount: replies.length + 1`). 데스크톱: 우측 패널 `MessageThreadPanel`, **답글을 depth로 들여쓴 트리**(Reddit식) — `MessageRow.tsx:636-640` 들여쓰기, `:642-736` 조상 가이드 레일, `:774-792` 연결 엘보. 상수 `threadTreeLayout.ts:1-19`(`MAX_VISIBLE_DEPTH = 6`, `DEPTH_STEP_REM = 2.25`, `LINE_WIDTH_REM = 0.09375`). 서버가 `depth > 100`을 거부(`crates/buzz-relay/src/handlers/ingest.rs:669-671`) | 채널 화면 위 **절대 위치 오버레이**(`ThreadPanel.tsx:215-222`), 리스트는 채널과 같은 `Timeline` 재사용, 루트를 배열 **맨 앞**에(`:103`). **루트와 답글 사이 구분선이 없다** — 헤더 부제 `'답글 N개'`(`:161-163`)가 유일한 신호 |
| 답글 컴포저 | 하단 도킹, placeholder `'Reply to this thread...'`(`post_input.tsx:76`) | 모바일 하단 도킹 + 위에 타이핑 인디케이터(`thread_detail_page.dart:383-391`). 데스크톱 placeholder `` `Reply in thread to ${threadHead.author}` ``(`MessageThreadPanel.tsx:882`) | 하단 도킹, placeholder `'답글 쓰기'` / 버튼 `'답글 보내기'`(`ThreadPanel.tsx:199-205`), 답글 0개면 위에 초대 문구(`:194-198`) |
| **키보드에 가려지는 문제** | 구조적으로 불가: inverted라 짧아도 하단 정렬, 키보드는 `contentInset.top`이 흡수(`post_list.tsx:530-539`) | 모바일 스레드는 정방향 상단 정렬이지만 **리스트가 `Expanded`라 키보드가 뷰포트를 줄일 뿐**(`thread_detail_page.dart:244-247`). 그리고 그들은 **반대 방향의 함정을 겪었다** — 하단 정렬이 "루트를 컴포저에 처박았다"(`:253-256`) | **발생한다.** §1 ② |
| 채널에서 답글의 정체 | 채널에 남고, 본문 왼쪽에 **3px 세로 막대**(`body.tsx:66-72` `replyBar`, 첫/마지막 답글 패딩 `:73-74`) + 헤더 아래 `Commented on {name}'s message:`(`commented_on/index.tsx:36-47`) | **채널에서 빠진다.** 최상위 타임라인은 `parentId == null`만 — 모바일 `timeline_message.dart:504,522`, 데스크톱 `formatTimelineMessages.ts:111`. **예외: `["broadcast","1"]` 태그가 있으면 채널에도 뜬다**(모바일 `:536`, 서버 `crates/buzz-db/src/thread.rs:649` `OR (tm.depth = 1 AND tm.broadcast = true)`). 단 **데스크톱 클라는 `broadcast`를 읽기만 하고 쓰지 않는다** | 채널에 남고 본문 **위**에 메타 크기 한 줄 `↳ ○○님에게 답글`(`MessageRow.tsx:267-304`, 배치 근거 `:722-725`) |

**성재 실측 결함에 대한 그들의 답:** Mattermost는 오버레이가 아니라 **화면**을 쓰고 리스트를 밀지 않고 `contentInset`으로 흡수한다. buzz는 리스트를 `Expanded`로 두어 프레임워크가 줄이게 한다. **우리만 뷰포트를 통째로 옮긴다.**

### 2-3. 인용 답글 (스레드와 다른 물건)

| | Mattermost | buzz | **momo 현재** |
|---|---|---|---|
| 데이터 모델 — 두 참조 공존 | `root_id` 하나뿐 | **둘 다 있다.** `schema/schema.sql:509-512` — `parent_event_id`/`parent_event_created_at`(직전 답글 대상)와 `root_event_id`/`root_event_created_at`(스레드 루트), 여기에 `depth`와 `broadcast`(`:517`)까지. 와이어는 NIP-10 마커: 부모=루트면 `["e", root, "", "reply"]` 하나, 아니면 `root`+`reply` 두 개(`desktop/.../lib/threading.ts:121,125-126`). **서버가 클라를 믿지 않고 조상을 검증한다** — 루트 불일치면 `"root tag does not match thread ancestry"`(`ingest.rs:654-656,697-699`) | **둘 다 있다.** `schema_v0.sql:175-176` — `root_id`(스레드 루트) + `reply_to_id uuid REFERENCES message(id) -- direct reply target`. 인덱스는 `root_id`에만(`:190`) |
| 그런데 실제로 쓰나 | — | `parent_event_id`는 **트리 들여쓰기**로 쓴다. **인용 블록은 없다** — `ParentPreview`/`replyPreview`/`quotedMessage`/`ReplyContext` 같은 컴포넌트가 `desktop/src/` 어디에도 없다. NIP-18 `q` 태그도 안 쓰고 `quote` 검색 결과는 전부 마크다운 인용문이다 | **`reply_to_id`는 서버 코드에도 클라이언트 타입에도 전혀 없다.** `packages/momo-core/src/lib/api.ts:138`의 `Message`는 `rootId?`만 노출한다. **컬럼은 파여 있고 배선이 하나도 없다** |
| 부모를 행 안에 그리나 | **아니다.** 가장 가까운 건 permalink 임베드 — 다른 메시지 링크를 붙이면 카드로 펼쳐진다: 아바타 32px + 이름 + 시각 + 본문 **150자 컷**(`permalink_preview.tsx:35` `MAX_PERMALINK_PREVIEW_CHARACTERS = 150`), 화면 높이 50% 넘으면 하단 그라디언트 페이드(`:155,319-325`), 탭하면 원문 점프(`:214-221`), 하단에 `Originally posted in ~채널`(`:328-337`) | **아니다.** 들여쓰기 + 연결선으로 대신한다(위 2-2) | 아니다 |
| 컴포저의 「답글 중」 + 취소 | 없음 | **있다 (데스크톱).** `ComposerReplyEditBanner.tsx` — 컴포저 위에 붙어 아래로 파고드는 배너(`-mb-4 … rounded-t-2xl border-b-0`, `:6-7`): `<CornerUpLeft>` 아이콘(`:60`) + **`Replying to {author}`**(`:62-64`) + 부모 본문 미리보기 한 줄(`:65-69`) + **`aria-label="Cancel reply"` 고스트 `<X>` 버튼**(`:71-82`). 편집 모드가 우선하며 `"Editing message"` + `"Cancel edit"`(`:26-51`). 컴포저 placeholder도 바뀐다 — `` `Reply to ${author} in #${channel}` ``(`MessageComposer.tsx:233-234`), 대상 변경 시 오토포커스(`:382-384`) | 없음 |
| 원문으로 점프 | permalink(`showPermalink`) | `buzz://message?channel=<uuid>&id=<eventId>`(`messageLink.ts:1-56`) → `jumpToMessage`(`MessageTimeline.tsx:448-536`) + 도착 하이라이트 `animate-[route-target-highlight-fade_2s_ease-out_forwards]`, `bg-primary/10`(`MessageRow.tsx:807-809`) | 없음 |

**결론:** **인용 블록 렌더는 셋 다 없다 — 우리가 하면 선례 없이 처음이다.** 하지만 ⑴ **두 참조를 함께 두는 데이터 모델**과 ⑵ **컴포저의 「답글 중 + 취소」 배너**는 buzz 데스크톱에 그대로 베낄 물건이 있다.

### 2-4. 작성 중(typing) 표시 — 비용 포함

| | Mattermost | buzz | **momo 현재** |
|---|---|---|---|
| 위치 | **컴포저 바로 위** — `DraftInput` 안 `<Typing/>`(`draft_input.tsx:227-230`), 고정 높이 컨테이너 `StatusIndicator`(`status_indicator/index.tsx:25-35`), `TYPING_HEIGHT = 16`(`constants/post_draft.ts:7`) | 모바일: 리스트와 컴포저 사이 `AnimatedSize`(`channel_detail_page.dart:379-387`, 스레드 `thread_detail_page.dart:383-391`). **데스크톱은 더 나아갔다** — 컴포저 독의 **예약된 하단 레일 안에 절대 배치**해서 페이드가 레이아웃 높이를 못 바꾸게 한다. `ChannelPane.tsx:796-799` 주석: *"anchored in the dock's reserved bottom rail, so fading it cannot change the observed overlay height or move the conversation."* 래퍼 `ComposerActivityAccessory.tsx:28-43`(`absolute inset-x-0 z-10`, opacity만 애니메이트), 이유 `:13-16` *"keeps timeline scroll padding stable."* | **없다. 기능 자체가 없다** — `clients/mobile/src`·`packages/momo-core/src`·`server` 어디에도 typing 이벤트가 없다 |
| 여러 명 문구 | 최대 **3명** 이름(`typing/index.tsx:125` `nextTyping.splice(3)`), `{user} is typing...` / `{users} and {last} are typing...`(`:134-158`) | 모바일 1/2/그외 3분기(`channel_typing_indicator.dart:25-29`), 아바타 `entries.take(3)`(`:30`) 24px·14px 겹침(`:55-70`). 데스크톱은 4분기 — 1·2·3명은 전부 나열, 4명 이상은 `` `A, B, and N-2 others are typing...` ``(`TypingIndicatorRow.tsx:38-52`), 정렬은 **최초 목격순**(`useChannelTyping.ts:234-238`) | — |
| 전송 빈도 | **키 입력마다 아님.** 서버 설정 `TimeBetweenUserTypingUpdatesMilliseconds` 이상 지났을 때만(`post_input.tsx:279-287`). 게이트 둘을 더 통과해야 한다: `EnableUserTypingMessages`, 그리고 **`membersInChannel < MaxNotificationsPerChannel`** — 큰 채널에서는 아예 끈다(`post_input.tsx:281-284`, 출처 `post_input/index.ts:22-24`) | **3초 선행 엣지 스로틀** — 모바일 `compose_bar/helpers.dart:3` `_typingThrottleMs = 3000`(사용 `compose_bar.dart:280`), 데스크톱 `useTypingBroadcast.ts:5` `TYPING_SEND_INTERVAL_MS = 3_000`(가드 `:37`), 트리거는 에디터 업데이트마다 `text.trim().length > 0`(`MessageComposer.tsx:265-267`). 채널 전환 시 스로틀 시계 리셋(`:31-34`) | — |
| 만료(TTL) | **stop 이벤트를 기다리지 않는다.** 수신 측이 `USER_TYPING`을 받는 즉시 같은 간격 뒤 `USER_STOP_TYPING`을 스스로 예약한다(`actions/websocket/users.ts:112-116`). 명시 stop이 오면 마지막 1명이 사라진 뒤 500ms 유예(`typing/index.tsx:80-86`) | **8초**, 1초마다 스윕 — 모바일 `channel_typing_provider.dart:27-28`(`_ttlMs = 8000`, `_pruneIntervalMs = 1000`), 데스크톱 `useChannelTyping.ts:29-30` 동일. 만료 시각은 **이벤트 자신의 `created_at` 기준**으로 계산한 뒤 로컬 시계와 min(`:87-90,124`) — 늦게 온 프레임이 수명을 못 늘린다. **stop 이벤트는 존재하지 않는다.** 그리고 **보낸 사람의 메시지가 도착하면 그 사람 표시를 즉시 지우고 2초 억제**(`:29-31` `TYPING_POST_MESSAGE_SUPPRESS_MS = 2_000`, 적용 `:160-171`) | — |
| 전송 채널 / 지속성 | 웹소켓 직행, DB 경유 없음 — `websocket/index.ts:462-467` `sendMessage('user_typing', {channel_id, parent_id})` | **kind:20002 임시 Nostr 이벤트.** `crates/buzz-core/src/kind.rs:453-454` `KIND_TYPING_INDICATOR = 20002`, 임시 범위 `EPHEMERAL_KIND_MIN/MAX = 20000/29999`(`:444,446`), 주석 *"Ephemeral events (20000–29999) — Redis pub/sub only, never stored."*(`:443-448`). **DB가 하드 거부한다** — `crates/buzz-db/src/event.rs:277-279,1127-1131` `return Err(DbError::EphemeralEventRejected(...))`. 릴레이는 검증→멤버십 확인→Redis publish→로컬 팬아웃(`buzz-relay/src/handlers/event.rs:762,831-866`). 전송은 fire-and-forget이고 **끊겨 있으면 재연결조차 하지 않는다**(`relayClientSession.ts:298-301` *"not worth triggering a reconnect for ephemeral typing events"*, `:312-313`) | — |
| 구독 비용 | — | `kinds:[20002], "#h":[channelId], limit: 10, since: now-10`(`relayClientSession.ts:362-375`; 모바일 `channel_typing_provider.dart:58-62`). **포럼 채널에서는 아예 구독 안 함**(`useChannelTyping.ts:180`) | — |
| **에이전트도 보내나** | — | **보낸다. 그리고 그게 「일하는 중」의 정본 신호다.** 하네스가 3초마다 갱신 — `crates/buzz-acp/src/lib.rs:1645-1650` `Duration::from_secs(3)`, 이벤트 빌더 `relay.rs:856-882`(kind `:879`), 턴이 끝나면 제거 `lib.rs:2446-2449`, 끄는 플래그 `--no-typing`/`BUZZ_ACP_NO_TYPING`(`config.rs:380-382,1094`), publish는 `try_publish_event`로 논블로킹(`lib.rs:2430`, 이유 `:2421-2424`). **그리고 봇 타이핑은 사람 타이핑 줄에서 분리해 따로 표시한다**(`useChannelActivityTyping.ts:88-102`) | — |

**비용, 그리고 우리에게 걸리는 것**
- 규모: 채널 인원 N, 동시 타이퍼 T일 때 대략 `T/3 회/초` publish × N 구독자 팬아웃. 수신 TTL 8초 = **전송을 두 번까지 놓쳐도 표시가 유지**되는 여유.
- **세 제품 모두 내구 저장소를 우회한다.** 우리 하드 룰은 `단일 쓰기경로(REST→PG→outbox→relay)`이므로 typing을 그 길로 넣으면 타이퍼 1명당 3초에 outbox 행 1개가 영구히 쌓인다 — 명백히 틀렸다. **Centrifugo client-side publish든 별도 경량 엔드포인트든 경계 변경이므로 Accepted ADR 없이는 착수 금지**(ADR-0100).
- **경고 1 — 문서와 코드가 다르다.** buzz `ARCHITECTURE.md:452-457,801`은 Redis 정렬셋(5초 창 / 60초 TTL)을 문서화해 두었지만 **구현이 없다**(`rg "buzz:typing" --glob '!*.md'` → 0건; `crates/buzz-pubsub/src/`에 `typing.rs` 없음; `lib.rs:43`의 `/// Typing indicator tracking in Redis.`는 아래에 모듈이 없는 고아 주석). 실제 계약은 **클라 스로틀 3초 / 클라 만료 8초 / 릴레이는 무상태 통과**뿐이다. 문서만 보고 베끼면 없는 것을 만든다.
- **경고 2 — buzz에는 레이트 리밋이 없다.** `ARCHITECTURE.md:390,823` — 유일한 구현체가 `AlwaysAllowRateLimiter`(테스트용). typing은 서명 이벤트 + 멤버십 조회 + Redis publish + 팬아웃인데 악의적 클라를 막는 것이 없다. **우리는 상한을 처음부터 넣어야 한다** — Mattermost의 인원 상한 게이트가 그 모델이다.

### 2-5. 에이전트/봇 메시지

| | Mattermost | buzz | **momo 현재** |
|---|---|---|---|
| 사람과 가르는 법 | 헤더에 태그. **`AGENT`와 `BOT`을 별개 뱃지로** 구분한다(`tag/agent_tag.tsx:9-12` / `tag/bot_tag.tsx:9-12`, 둘 다 `uppercase`; 분기 `header/tag/index.tsx:20-23`, `isAutomation = isWebHook \|\| author?.isBot` `header.tsx:149`). AI 생성글은 `creation-outline` 아이콘(`ai_generated_indicator.tsx:44-51`). 자동완성 행도 같은 뱃지(`user_item.tsx:194-199`, `at_mention_item/index.tsx:27-36`) | **데스크톱: 본문 스타일은 사람과 완전히 같다.** 다른 건 헤더/아바타에 얹은 셋: ⑴ `<Bot>` + **`managed by <owner>`** 칩(`MessageAgentOwner.tsx:26-27`, 소유자 미검증이면 `"owner unavailable"` `:44-45`; 배치 `MessageRow.tsx:478-483,575`) ⑵ **아바타 모서리의 `respondTo` 위험 뱃지** — `anyone`이면 호박색 `<AlertTriangle>` + `"Anyone can send instructions to this agent"`, `allowlist`면 파란 점, `owner-only`면 없음(`MessageRow.tsx:404-430`, 타입 `types.ts:39`) ⑶ 페르소나 부제(`:577-582`). **모바일은 행에서 아예 구분하지 않고** @멘션 필의 `@`를 봇 아이콘으로 바꾸는 것뿐(`message_content.dart:802,862`) | 헤더에 이름을 보라색(`color.agent`)으로 + `'에이전트'` 배지(`MessageRow.tsx:174-178,1040-1046`) + `'○○님이 관리'`(`:179-183`). **buzz의 `managed by`와 사실상 같은 발상이고, 우리 쪽이 모바일에 먼저 있다** |
| 스트리밍 / 실행 중 | **행 안에서 스트리밍한다.** `StreamingIndicator` = 2×16px 세로 커서 800ms in/out 점멸(`streaming_indicator.tsx:18-32,44-50`), 본문 옆(`agent_post_new.tsx:247-249`) 또는 본문 전이면 `'Generating response...'` + 커서(`:216-225`). 상태는 `streamingStore`의 `generating`/`precontent`/`isReasoningLoading`(`:103-106`) | **타임라인에는 토큰 스트리밍이 없다 — 에이전트는 완성된 kind:9 하나를 올린다.** ACP 델타(`agent_message_chunk`/`tool_call`/…)는 하네스가 소비해 로그만 남긴다(`crates/buzz-acp/src/acp.rs:1731-1768`). 풍부한 스트림은 **소유자 전용 NIP-44 암호화 사이드채널** kind **24200**(`kind.rs:456`)으로 가서 **별도 Agent Session 패널**에 그려진다. 채널로 나가는 유일한 임시 신호는 typing(`relay.rs:856`). 채널 표면에는 컴포저 레일의 `BotActivityBar`만 뜬다 — `` `${name} is working` `` / `` `${n} agents working` ``(`:148-149`), 헤드라인 최대 5개(`:71-92`), `<Shimmer>` + `<Loader2 animate-spin>`(`:209-217`), 헤드라인은 어시스턴트 첫 줄 **72자 컷**(`agentSessionTranscriptPresentation.ts:42-44`) | 상태 칩 텍스트뿐(`MessageRow.tsx:369` `TURN_STATUS_LABEL`), **애니메이션 없음.** 아티팩트 노트가 `note.live`면 말줄임표를 붙이는 정도(`:440`) |
| 「일하는 중」 상태 기계 | — | 관측 프레임이 1순위, 봇 타이핑이 폴백(`agentWorkingSignal.ts:19-24,31-40,133-180`). 상수 `activeAgentTurnsStore.ts` — `LIVENESS_INTERVAL_MS = 10_000`(`:12`), `REMOVE_AFTER_MS = ×2.5`=25s(`:18`), `FRAME_GAP_PAUSE_MS = ×2`=20s(`:23`), `PRUNE_PAUSE_MAX_MS = 180_000`(`:25`), `MAX_TURNS_PER_AGENT = 32`(`:31`), `PRUNE_INTERVAL_MS = 5_000`(`:38`). 서버 `BUZZ_ACP_TURN_LIVENESS_SECS` 기본 10(`config.rs:300-303`) | 없음 |
| 긴 출력 접기 | **전부 기본 접힘.** `ReasoningDisplay`는 접힌 채 `'Thinking'` 한 줄(`reasoning_display/index.tsx:80,100-120`), 펼치면 `maxHeight: 600`(`:57-59`). `ToolCard`는 인자·결과 각각 접힘(`tool_card/index.tsx:339-424`), 헤더는 상태 아이콘 4종(pending 스피너 / `check-circle` / `alert-circle-outline` / `close-circle-outline`, `:261-306`) + 툴 이름 1줄. 터치 타깃 `TOUCH_TARGET_SIZE = 44`(`agents/constants.ts:15`) | **채널 타임라인에는 접기도 「더 보기」도 없다**(`rg "Show more\|See more\|Read more" desktop/src` → 0건). 대신 **애초에 긴 것을 채널에 안 보낸다**: 툴 출력은 생산 단계에서 잘리고(`crates/buzz-dev-mcp/src/shell.rs:20-22` `MAX_BYTES = 50KB` / `MAX_LINES = 2000` / **`TAIL_BYTES = 8KB`가 LLM이 보는 전부**, 전체 10MB는 아티팩트 파일로), diff는 CLI가 `MAX_DIFF_BYTES = 61_440`(60KiB)로 자르고 `"[diff truncated — exceeded size limit]"`를 붙인다(`crates/buzz-cli/src/validate.rs:7,104`). 모바일 트랜스크립트도 200자 이하만 자동 펼침(`transcript_item_widget.dart:89,92`), 메타 500자 컷(`:248-249`), 툴 결과 **2000자 컷 + `"… (truncated)"`**(`:404-405`), 프레임 보존 800개(`observer_subscription.dart:13`). 데스크톱 diff는 전용 카드 — `max-h-[400px] overflow-auto`(`DiffMessage.tsx:123-124`) + `<Maximize2>` `aria-label="Expand diff"`(`:97-113`) → `max-w-5xl h-[80vh]` 모달(`DiffMessageExpanded.tsx:39`) | **접기가 없다.** `card.detail.rows`를 전부 그리고(`MessageRow.tsx:397-413`, 값만 `numberOfLines={3}`), 본문에 ``` 이 있으면 `CodeBlock`으로 통째로 그린다(`:307-319,751-768`) — **줄 수 제한 없음.** diff만 파일 6개까지 자르고 나머지 개수를 적는다(`:454-468`) |
| 승인 | **행 안에 인라인.** Accept/Reject(`tool_card/index.tsx:463-492`), 결과 단계는 Share / Keep private + 경고 콜아웃(`:494-531`, 문구 `:418`). 중단 버튼도 있다(`agent_post_new.tsx:255-262` `ControlsBar`, `handleStop` `:183-188`) | **데스크톱은 사용자에게 묻지 않는다 — 하네스가 자동 승인한다**(`crates/buzz-acp/src/acp.rs:1882-1930`, `allow_once` 우선 `:1905-1907`, 실패 시 `reject_once` `:1918-1922`). UI는 사후 기록만(호박색 카드 `LifecycleActivity.tsx:54-103`, `"Approved"/"Denied"/"Cancelled"` `agentSessionTranscript.ts:232-250`) | **승인 버튼이 없다.** 대신 이렇게 적혀 있다 — `'이 결정은 인박스나 데스크톱 앱에서 처리할 수 있습니다.'`(`MessageRow.tsx:354-357`). **에이전트가 1급 멤버인 제품에서 폰으로는 승인을 못 한다** |
| 실패 / 중단 | 상태 아이콘 + 색(`tool_card/index.tsx:283-292`) | 파괴적 카드(`LifecycleActivity.tsx:105-119`), 친화적 문구 매핑 — `-32001 → "Community access denied this agent…"`, `-32002 → "The configured model is not available…"`(`friendlyAgentLastError.ts:39-43`). 중단은 UI 메뉴 `"Stop current turn"`(`AgentSessionThreadPanel.tsx:405-407`, 게이트 `:108`) **또는 채팅 규약** — 소유자가 `!shutdown`/`!cancel`을 kind:9로 보내고 `#p`로 에이전트를 지목(`crates/buzz-core/src/kind.rs:463-467`, 처리 `buzz-acp/src/lib.rs:2103-2208`) | `errorNote`/`failure` 텍스트(`MessageRow.tsx:371-378`). 중단 없음 |

**이 표에서 가장 중요한 한 줄:** **셋 중 에이전트의 작업 내역을 채널 타임라인에 펼쳐 놓는 것은 우리뿐이다.** Mattermost는 행 안에서 스트리밍하되 **전부 접어** 둔다. buzz는 아예 **채널에 안 보내고** 별도 패널로 뺀다. 우리 `AgentCard`/`ArtifactCard`는 `detail.rows`를 전부 펼치고 코드블록에 상한이 없다 — 에이전트가 말할수록 대화가 로그가 된다.

### 2-6. 키보드·입력

| | Mattermost | buzz | **momo 현재** |
|---|---|---|---|
| 키보드 닫는 법 | ① `keyboardDismissMode='interactive'`(`post_list.tsx:564`) ② **메시지 탭 → `dismissKeyboard()`**(`post.tsx:239`, `utils/keyboard.ts:15-22`) ③ 화면 이동 전 `blurAndDismissKeyboard()`(`post.tsx:218`) ④ 스레드 오버뷰 ⋯ 탭 시 `Keyboard.dismiss()`(`thread_overview.tsx:70`) | 모바일: 리스트(`message_list.dart:251`)와 컴포저 바(`layout.dart:262-306`) **양쪽**에서 아래로 **48px 누적 드래그**(`keyboard_dismiss_on_drag.dart:8`). 텍스트 필드 안에서 시작한 드래그는 `RenderEditable` 히트테스트로 제외(`layout.dart:275-283,293`). 주석 `keyboard_dismiss_on_drag.dart:12-15`는 Flutter 기본 `ScrollViewKeyboardDismissBehavior.onDrag`가 "첫 픽셀에 발동해서" 못 쓴다고 적고 직접 만들었다고 밝힌다. 바깥 탭·명시 버튼은 없다 | **`keyboardDismissMode="interactive"` 하나뿐**(`Timeline.tsx:804`). 짧은 리스트에서는 발동하지 않는다 |
| 전송 버튼 | 32×80 사각 + **아이콘(`send`)**, 비활성은 `buttonBg` 30% 불투명(`send_button.tsx:28-41,90-92`). 롱프레스로 예약 전송 | 모바일 36×36 원형 `arrowUp`, 전송 중엔 스피너(`compose_bar/send_button.dart:16-19`). **빈 입력에서 비활성이 아니다** — 비활성 조건은 업로드 대기뿐(`layout.dart:227-231` `isDisabled: hasPendingUploads`)이고 빈 텍스트는 `send()` 안에서 조용히 return(`compose_bar.dart:427-433`) | `minHeight: 44, minWidth: 64`, **한글 텍스트**(`'보내기'`/`'답글 보내기'`), 빈 입력이면 비활성 + 회색(`Composer.tsx:237-252,288-300`). **셋 중 상태 표현이 가장 정확하다.** 다만 텍스트라 폭을 64px+ 먹는다 |
| 여러 줄 성장 | `maxHeight = isTablet ? 150 : 88`(`post_input.tsx:172`), 본문 15/20(`:87-88`) | 모바일 `minLines: 1, maxLines: 5`(`layout.dart:112-113`). 포커스 전에는 **`TextField`가 아니라 힌트 `Text`**이고 탭하면 스프링으로 펼쳐진다(`layout.dart:130-164`) | `MAX_HEIGHT = 120`(`Composer.tsx:62`), `minHeight: TOUCH_TARGET`(44), 본문 16/21(`:271-287`) |
| Enter | `submitBehavior='newline'`(`post_input.tsx:406`) — 소프트 키보드 Enter는 줄바꿈. 하드웨어 Enter만 전송(`:308-318`) | 모바일 `TextInputAction.send` + `onSubmitted: (_) => onSend()`(`layout.dart:105,111`) — **Enter가 전송이다** | `blurOnSubmit={false}` + 버튼만 전송(`Composer.tsx:233`, 근거 `:51-58`). **Mattermost와 같은 판단** |
| 멘션 자동완성 위치 | 절대 위치 오버레이, 컴포저 위에 `bottom: position`(`autocomplete.tsx:23,136-139`), `MAX_LIST_HEIGHT = 230`(`constants/autocomplete.ts:27`) | 모바일 **`OverlayPortal`** — 컴포저를 리플로우시키지 않는다(`compose_bar.dart:896`, 컨트롤러 `:806`). `maxHeight: 240`(`suggestions.dart:115,265`), 후보 상한 50(`helpers.dart:13`, 주석: 데스크톱 `MENTION_SUGGESTION_LIMIT`와 일치) | **컴포저 루트 안의 형제 View**(`Composer.tsx:171-205`), `maxHeight: 180`(`:302`). **목록이 뜨면 컴포저가 위로 자라 리스트가 줄어든다** → 멘션 타이핑 중 타임라인이 움찔한다 |
| 멘션 행의 에이전트 표기 | `AGENT`/`BOT` 뱃지(위 2-5) | 봇 아이콘 12px + `'agent'`(`suggestions.dart:205,210`), 관리자는 `'admin'`(`:222`), 부가 문구 `'managed by {owner} · not in channel'`(`:186-190`) | 이름 보라색 + `'에이전트'`(`Composer.tsx:188-200`). 소유자·소속 문구는 없다 |

---

## 3. momo 적용안 (우선순위)

크기: 작음 = 1파일 수준 · 중간 = 2~4파일 + 테스트 · 큼 = 서버·코어·클라 전부.

### P0-1. 메시지 **탭**에 뜻을 준다 — 스레드 열기 + 키보드 닫기 / 롱프레스 450→250ms
**무엇** `MessageRow.tsx:706-713`의 `Pressable`에 `onPress`: ⑴ `longPress.consumeTap()`이면 무시(이미 있는 장치) ⑵ `Keyboard.dismiss()` ⑶ `actions.onOpenThread`가 있으면 그 메시지의 스레드를 연다(롤업이 없어도 — 그게 MM·buzz 공통 동작이다). 동시에 `LONG_PRESS_MS`를 250 안팎으로.
**왜** `post.tsx:458-460` / `message_bubble.dart:80-96`. 지금은 진입점이 보이지 않는 제스처 하나뿐이라 `LongPressHint`라는 교육용 컴포넌트를 따로 유지하고 있다 — 탭이 살아나면 은퇴시킬 수 있다.
**우리 제약과의 충돌** **없음.** 컴포저 `value` 동기 · `inverted` 금지 · 따라가기 규칙 · 44px 어디에도 닿지 않는다. `MessageRow.tsx:707`이 적은 "두 번째 제스처가 경쟁한다"는 우려는 `Pressable`의 `delayLongPress`가 이미 처리하고, 두 레퍼런스가 실제로 경쟁시키고 산다.
**크기** 작음.

### P0-2. 키보드가 올라올 때 **짧은 대화가 화면 밖으로 나가지 않게** 한다
성재가 본 스레드 결함의 근본 원인이고, **두 갈래가 있다. 둘 다 재고 하나를 고른다.**

**(a) 리스트를 밀지 말고 인셋으로 흡수한다 — Mattermost 방식. 더 정확하지만 더 크다.**
`ConversationLayout`이 팬 전체를 올리는 대신 컴포저만 올리고, 리스트에는 `contentInset`/`scrollIndicatorInsets`를 준다. Mattermost가 `useAnimatedProps`로 하는 그대로이므로(`post_list.tsx:530-539`) **레이아웃 프롭이 아니고 UI 스레드에서 돈다** — RN-P2가 `paddingBottom`을 버린 이유(레이아웃 패스)에 걸리지 않는다.
**충돌** 없음. 단 `KeyboardPane` 네이티브 모듈이 지금 팬 전체를 옮기므로(`keyboardPane.tsx:26-29`) 그 계약을 "컴포저만"으로 좁혀야 한다. **크기** 중간~큼.

**(b) 짧은 콘텐츠를 뷰포트 바닥에 붙인다 — 한 줄, 그러나 buzz가 반례를 남겼다.**
`Timeline`의 FlatList에 `contentContainerStyle={{flexGrow: 1, justifyContent: 'flex-end'}}`. 콘텐츠가 뷰포트보다 길어지는 순간 무효가 되므로 긴 대화는 그대로다.
**충돌** `inverted`가 아니고 위치 보존/따라가기(`Timeline.tsx:441-641`)는 스크롤 오프셋만 다루므로 형식적 충돌은 없다. **그러나 buzz가 정확히 이걸 해 보고 되돌렸다** — `thread_detail_page.dart:253-256`: *"The old reversed list bottom-anchored the content, which jammed the head against the composer whenever a thread had only a handful of replies."* 답글 2개짜리 스레드에서 루트가 컴포저에 딱 붙고 화면 위쪽이 텅 비는 그림이다. **채널에는 안전하고 스레드에는 위험하다.**
**크기** 작음.

**권고** (b)를 **채널에만** 먼저 넣어 재고, 스레드는 (a)로 간다. 혹은 (a) 하나로 둘 다 푼다.
**어디서 재나** 시드 3~5줄 스레드에 키보드를 올리고 루트 행의 `measureInWindow`를 읽는다 — 측정 시임이 이미 있다(`Timeline.tsx:352-361` `anchorSeq`/`anchorRef`, `:377` `tailRef`, `:383` `metricsRef`) + `clients/mobile/measure/` 하네스. 회귀는 `__tests__/conversationLayout.test.tsx`·`__tests__/timelineRender.test.tsx`.

### P0-3. 키보드를 닫는 길을 셋으로 늘린다
**무엇** ⑴ P0-1의 메시지 탭에 `Keyboard.dismiss()` 포함 ⑵ `ScreenHeader` 탭 시 dismiss ⑶ (선택) buzz식 누적 드래그 — 리스트와 컴포저 바 양쪽, 아래로 48px(`keyboard_dismiss_on_drag.dart:8`), 텍스트 필드에서 시작한 드래그는 제외(`layout.dart:275-283,293`).
**충돌** 없음. ⑶은 raw 포인터 리스너라 컴포저의 `value` 동기 규칙을 건드리지 않는다. **크기** ⑴⑵ 작음 / ⑶ 중간.

### P1-1. 스크롤-투-엔드 버튼 + 「새 메시지」 배지 (+ 위쪽 미읽음 점프)
**무엇** ⑴ 하단 40px 원형 FAB — 바닥에서 멀어지면 등장(MM 임계 `CONTENT_OFFSET_THRESHOLD = 160`, `post_list.tsx:79,309`), 스크롤을 올린 동안 새 메시지가 오면 `'새 메시지'` 배지로 확장(`scroll_to_end_view.tsx:101,108,125-127`, 최대 폭 169). buzz도 같은 것이 있다 — 모바일 `'Latest'` FAB(`message_list.dart:355-376`), 데스크톱 하단 pill은 개수가 있으면 `'N new messages'` 없으면 `'Jump to latest'`(`MessageTimeline.tsx:827-849`, 라벨 `UnreadPill.tsx:8-10`). ⑵ 위쪽 pill — 미읽음이 화면 위에 있으면 `'N개 새 메시지'`를 띄우고 누르면 첫 미읽음으로 점프(MM `more_messages.tsx:289`; buzz `MessageTimeline.tsx:665-678`, 바닥에 닿으면 자동 소멸 `:472-475`).
**왜** 우리 제약 「남이 말하면 위치 안 뺏김(≤2px)」은 옳지만 **대가가 있다**: 읽던 중 대화가 살아 있는지 알 방법도, 바닥으로 돌아갈 길도 없다. **세 제품이 전부 이 대가를 두 개의 어포던스로 갚는다.**
**충돌** 없음 — **오히려 제약을 지키기 위한 보완재다.** 위치를 안 뺏으니 알려는 줘야 한다.
**크기** 중간(`Timeline`에 상태 하나 + 오버레이 하나. `followingRef`·`geometryRef`·`distanceToEnd()`(`Timeline.tsx:276-279`)가 이미 필요한 숫자를 들고 있다).

### P1-2. 인용 답글 — 스키마의 `reply_to_id`를 살린다 (성재 명시 요청)
**무엇** ⑴ 서버: `SendMessageRequest`에 `replyToId`, `message.reply_to_id`에 기록. 읽기 경로에서 부모의 (작성자, 본문 앞부분)만 함께 실어 준다. **buzz처럼 서버가 조상을 검증한다**(`ingest.rs:654-656`) — 클라가 보낸 참조를 그대로 믿지 않는다. ⑵ 코어 `Message.replyToId` + 부모 프리뷰 타입. ⑶ RN: 본문 **위**에 인용 블록(작성자 + 본문 컷 — MM의 `MAX_PERMALINK_PREVIEW_CHARACTERS = 150`(`permalink_preview.tsx:35`)이 쓸 만한 상한), 탭하면 원문 점프 + 도착 하이라이트(buzz `MessageRow.tsx:807-809`). ⑷ 컴포저: **buzz 데스크톱의 배너를 그대로** — 아이콘 + `'○○에게 답글'` + 부모 미리보기 한 줄 + `'답글 취소'` X 버튼(`ComposerReplyEditBanner.tsx:60-82`), placeholder도 바꾼다(`MessageComposer.tsx:233-234`).
**왜** 성재가 지목했고, 컬럼이 이미 있고(`schema_v0.sql:176`), buzz가 **두 참조를 함께 두는 것이 정상임을 증명한다**(`schema/schema.sql:509-512` `parent_event_id` + `root_event_id`). 렌더 규칙: 둘 다 있으면 `↳ 답글` 표식(스레드 소속)과 인용 블록(무엇에 답하는지)이 함께 뜨되, 스레드 화면 안에서는 인용 블록만 남긴다(`markReplies={false}`와 같은 원리, `ThreadPanel.tsx:188`).
**충돌** **컴포저 `value` 동기 규칙과 충돌하지 않는다** — 인용 대상은 텍스트가 아니라 별도 상태이므로 `onChangeText`→`setText` 사이에 아무것도 끼지 않는다. 다만 **API + 스키마 사용 = 경계 변경이므로 Accepted ADR 없이 머지 금지**(ADR-0100). **인용 블록 렌더 규격은 베낄 선례가 없다**(셋 다 없다) — 우리가 정해야 한다.
**크기** 큼.

### P1-3. 에이전트 메시지: 진행 표시 + 긴 출력 접기 + 폰 승인
**무엇** ⑴ **진행 중 애니메이션** — MM식 점멸 커서(2×16px, 800ms in/out, `streaming_indicator.tsx:44-50`)를 `AgentCard`의 진행 상태에 붙인다. ⑵ **기본 접힘** — `card.detail.rows`와 `CodeBlock`을 접고 헤더는 상태 아이콘 + 한 줄 요약만(MM `ToolCard` 구조 `tool_card/index.tsx:315-337`), 코드블록에 줄 수 상한 + `'… 잘림'`. **상한 값은 그들에게서 가져온다**: buzz 툴 결과 2000자(`transcript_item_widget.dart:404-405`), 메타 500자(`:248-249`), diff 60KiB(`crates/buzz-cli/src/validate.rs:7`), MM reasoning 펼침 상한 `maxHeight: 600`(`reasoning_display/index.tsx:57-59`), diff 카드 `max-h-[400px]` + 전체는 모달(`DiffMessage.tsx:123-124`, `DiffMessageExpanded.tsx:39`). ⑶ **승인/거부를 행 안에 인라인**(MM `tool_card/index.tsx:463-492`, 결과 단계 Share/Keep private `:494-531`).
**왜** 성재가 「에이전트 답변·에이전트 채팅」을 지목했다. 그리고 §2-5의 한 줄: **에이전트 작업 내역을 채널에 펼쳐 두는 것은 셋 중 우리뿐**이다. 승인이 없으면 폰에서 에이전트는 1급 멤버가 아니다.
**충돌** 없음(44px는 `TOUCH_TARGET`으로 이미 강제, MM도 같은 값 `agents/constants.ts:15`). ⑶ 승인은 서버 액션이므로 **API 경계 확인 필요**.
**크기** ⑴⑵ 중간 / ⑶ 중간~큼.

### P2-1. 에이전트를 연속 묶기에서 제외한다
`startsAuthorGroup`(`model.ts:289-299`)에 "작성자가 에이전트면 항상 새 그룹". MM이 명시적으로 그렇게 한다(`post/index.ts:130`, AI 글은 `utils/post/index.ts:26-29`). **충돌** 없음. **크기** 작음.

### P2-2. 멘션 자동완성을 오버레이로 띄운다
지금은 컴포저 루트 안의 형제 View라(`Composer.tsx:171-205`) 목록이 뜨면 컴포저가 자라고 리스트가 줄어든다. buzz 모바일의 `OverlayPortal`(`compose_bar.dart:896`)이나 MM의 절대 위치 오버레이(`autocomplete.tsx:23,136-139`)처럼 **떠 있는 레이어**로 바꾼다.
**왜** buzz 데스크톱이 같은 이유를 명시적으로 적어 두었다 — 컴포저 독의 부속물은 **레이아웃 높이를 바꾸지 않도록** 절대 배치한다, *"keeps timeline scroll padding stable"*(`ComposerActivityAccessory.tsx:13-16`, `ChannelPane.tsx:796-799`). 「남이 말하면 위치 안 뺏김」을 지키는 제품에서 **내 타이핑이 위치를 뺏고 있다.**
**충돌** 없음(값은 여전히 동기). **크기** 중간.

### P2-3. 스레드 화면: 루트/답글 구분선 + 참여자 아바타 롤업
⑴ 스레드에서 루트 다음에 `'답글 N개'` 구분 줄(MM `ThreadOverview` `thread_overview.tsx:94-132`). ⑵ 채널 롤업 링크에 참여자 아바타 스택(MM `footer.tsx:161-172`, buzz `system_rows.dart:532`). **충돌** 없음. **크기** ⑴ 작음 / ⑵ 중간.

### P2-4. 아바타 열
32~40px 아바타 열을 세우고 연속 행에서는 그 폭을 빈칸으로. 세 클라이언트의 유일한 공통 레이아웃이고, 연속 행에 시선의 앵커를 준다. **여백이 아니라 기둥이 문제다**(§1 덧). buzz 데스크톱처럼 그 빈칸에 **호버/롱프레스 시 시각을 되살리는** 변형도 있다(`MessageRow.tsx:434-449`). **충돌** 없음(가로 스크롤 0 유지, 본문 폭이 32~42px 줄어든다). **크기** 중간(이미지 로딩·플레이스홀더·이니셜 폴백이 없다).

### P3. 작성 중(typing) 표시 — **ADR 먼저**
**무엇(세 제품에서 수렴한 규격)** 컴포저 독의 **고정 높이 레일**(MM `TYPING_HEIGHT = 16`; buzz 데스크톱은 레이아웃을 못 바꾸게 절대 배치) · 최대 3명 이름 · **선행 엣지 스로틀 3초**(buzz 모바일·데스크톱 동일) · **수신 TTL 8초 + 1초 스윕**, 만료는 이벤트 자신의 `created_at` 기준(`useChannelTyping.ts:87-90,124`) · **stop 이벤트 없음**(셋 다 안 쓴다) · **보낸 사람 메시지 도착 시 즉시 제거 + 2초 억제**(`:29-31,160-171`) · **채널 인원 상한 게이트**(MM `membersInChannel < MaxNotificationsPerChannel`) · **끊겨 있으면 재연결하지 않고 버린다**(`relayClientSession.ts:298-301`).
**에이전트 typing** buzz는 하네스가 3초마다 보내고(`crates/buzz-acp/src/lib.rs:1645-1650`) 그것으로 「일하는 중」을 만든다. **다만 봇 타이핑은 사람 타이핑 줄에서 분리해 표시한다**(`useChannelActivityTyping.ts:88-102`) — 사람 3명 + 에이전트 2개가 "5명이 입력 중"이 되면 안 된다.
**충돌** **있다.** typing은 PG를 거치면 안 되는데 우리 하드 룰은 `단일 쓰기경로(REST→PG→outbox→relay)`다. Centrifugo client-side publish든 별도 엔드포인트든 **경계 변경 → Accepted ADR 필수.** 그 ADR에서 함께 결정할 것: 에이전트도 보내는가, 인원 상한은 얼마인가, **레이트 리밋을 처음부터 넣는가**(buzz는 안 넣어서 §2-4 경고 2가 됐다).
**크기** 큼.

---

## 4. 하지 말 것

1. **`inverted` 리스트.** MM이 쓰지만 그러려고 RN 코어를 패치한다(`patches/react-native+0.83.9.patch`). buzz 모바일 채널도 `reverse: true`(`message_list.dart:254`)지만 **모바일 스레드는 정방향으로 되돌렸고**(`thread_detail_page.dart:253-256`) **데스크톱은 처음부터 정방향**이다(`virtua` `VList`, `shift={isPrepend}`로 프리펜드 보정 — 우리 `maintainVisibleContentPosition`과 같은 발상). 우리 실측은 인버티드 46~91px vs 정방향 0px(`Timeline.tsx:36-48`)이고 `clients/mobile/__tests__/projectShape.test.ts:153-161`이 `src/`에 `inverted`가 다시 나타나면 빌드를 깨뜨린다. **정방향은 검증됐다. 유지.**
2. **오프라인 SQLite/WatermelonDB 전제.** MM 모바일 전체가 로컬 DB 위에 서 있어 `previousPost`/`nextPost`를 관측 가능한 관계로 공짜로 얻는다. 우리는 PG=SoT + 메모리 배열이므로 흉내 내지 말 것 — `buildThreadContext`(`threadContext.ts:61-82`)처럼 렌더 배열에서 한 번에 파생하는 지금 방식이 맞다.
3. **buzz처럼 답글을 채널에서 빼기.** buzz는 `parentId == null`만 남긴다(모바일 `timeline_message.dart:504,522`, 데스크톱 `formatTimelineMessages.ts:111`). 이건 P12 「채널 밖 답글」의 문자 그대로의 이행이고 **읽던 사람 눈앞에서 행이 사라지는 변화**다 — `threadContext.ts:30-33`이 이미 "ADR 없이 드라이브바이로 할 일이 아니다"라고 못 박았다. **유지.** (덧: buzz의 `broadcast` 탈출구는 **데스크톱 클라가 읽기만 하고 쓰지 않아** 사실상 죽어 있다 — 반쪽 기능을 베끼지 말 것.)
4. **buzz의 전송 버튼 상태.** 빈 입력에서도 활성처럼 보이고 눌러도 조용히 아무 일이 없다(`layout.dart:227-231` + `compose_bar.dart:427-433`). 우리 `Composer.tsx:240-251`이 맞다.
5. **buzz 모바일의 전송 실패 처리.** 실패하면 로컬 행을 지운다(`send_message_provider.dart`) — 사용자는 메시지가 어디 갔는지 알 수 없다. 우리 `PendingRow`의 `'전송 실패' + '다시 보내기'`(`MessageRow.tsx:998-1011`)가 맞다.
6. **buzz 모바일의 Enter=전송.** `TextInputAction.send`(`layout.dart:105,111`)는 소프트 키보드에서 여러 줄 작성을 죽인다. MM은 `submitBehavior='newline'`(`post_input.tsx:406`)으로 우리와 같은 판단을 했다. **유지.**
7. **buzz의 승인 모델(자동 승인).** 하네스가 사용자에게 묻지 않고 `allow_once`를 고른다(`crates/buzz-acp/src/acp.rs:1882-1930`). 우리 제품은 승인 게이트가 제품의 일부이므로 **MM의 인라인 Accept/Reject를 따른다.**
8. **에이전트 메시지를 사람과 시각적으로 동일하게 두기.** buzz 모바일이 그렇다(행에 봇 표시 없음). 우리 전제(에이전트=1급 멤버, 이름을 가진 동료)와 어긋난다. 우리 배지·색·`'○○님이 관리'`(`MessageRow.tsx:164-183`)를 유지하고 오히려 강화(P2-1).
9. **문서를 소스로 삼기.** buzz `ARCHITECTURE.md:452-457,801`은 Redis typing 정렬셋(5초/60초 TTL)을 문서화해 두었으나 **코드에 없다**(§2-4 경고 1). 이 문서의 모든 수치는 코드에서 읽었고, 다음 사람도 그래야 한다.
10. **"여백을 늘려라" 류의 조정.** 우리가 두 레퍼런스보다 이미 빽빽하다(§1 덧). 밀도를 손대기 전에 P0-1~P0-3을 먼저 하고 다시 재라.

---

## 5. 미확인

- **Mattermost 서버의 `TimeBetweenUserTypingUpdatesMilliseconds` 기본값.** 모바일 레포는 서버 설정을 읽기만 한다(`post_input/index.ts:22`). 확인하려면 `mattermost/mattermost` 서버 레포가 필요하다. (참고로 buzz는 클라 상수 3000ms로 못 박혀 있다.)
- **buzz Flutter 스레드 화면에서 키보드가 올라올 때의 실제 픽셀 동작.** `Scaffold`의 `resizeToAvoidBottomInset` 기본값에 의존하는 것으로 보이나 코드에 명시가 없다 — 실행하지 않았으므로 화면으로 확인하지 못했다.
- **P0-2 (a)/(b)의 실측.** `justifyContent:'flex-end'`가 `maintainVisibleContentPosition`과 어떻게 상호작용하는지, 그리고 `contentInset` 경로가 `KeyboardPane` 네이티브 계약과 어떻게 맞물리는지는 **소스만으로 단정 불가.** 실기기/시뮬레이터 측정 필요.
- **ThreadPanel의 안전영역 이중 적용 여부.** `ConversationScreen.tsx:197`의 `<Screen>`(=`atoms.tsx:57` `paddingTop: insets.top`) 안에 `ThreadPanel.tsx:215-222`의 절대 위치 오버레이가 놓이고 그 안에서 `ThreadPanel.tsx:158`이 `<Screen>`을 다시 쓴다. Yoga가 절대 위치 자식을 부모의 border box 기준으로 놓는지 padding box 기준으로 놓는지에 따라 상단 인셋이 한 번일 수도 두 번일 수도 있다 — **실기기에서 재야 한다.**
- **momo `Timeline`의 실제 스크롤 성능**은 이 조사 범위 밖이다(읽기만 했고 실행하지 않았다).
- **buzz 웹(`web/src`)**은 초대·레포 표면만 있어 채팅 UI를 찾지 못했다 — 보지 않았다.
