# Message foundation — #4830 / ADR-0213 §3·§4·§9

P0-1 adds 11 shared ko/en keys, ICU validation, generated argument types and
compiled AST, and a platform-free FormatJS wrapper. No product screen changes.
The accepted ADR is `docs/adr/0213-internationalization-foundation.md` (landed on
`track/engine`; it reaches this track with the S1–S3 promotion).

```ts
import { createMessageService, loadMessageCatalog } from '@momo/core/i18n';

const catalog = await loadMessageCatalog('ko-KR');
const messages = createMessageService({ messageLocale: 'ko-KR', catalog });
messages.formatMessage('settings.profile.languageLabel'); // 언어
messages.formatMessage('common.members.count', { count: 2 }); // 2명
```

- `catalogs/<locale>/<feature>.json` is the source. Keys are
  `feature.surface.intent`; ko/en key and argument sets must match.
- `npm --prefix packages/momo-core run i18n:generate` validates and regenerates
  `generated/*.ts`. `i18n:check` fails on invalid source or stale generated files.
  The compiler checks duplicate JSON keys, nonempty catalogs/messages, key/argument
  syntax, ICU parsing, `other`, and cross-language argument names/types. Plain
  `{count}` can share a number contract with English plural syntax; incompatible
  explicit number/date/string uses fail. Rich text awaits an approved token adapter.
- `MessageKey`, `MessageArgs`, `messageKeys`, `argumentSpecs`, `MessageCatalog`, and
  `MessageService` are public. The runtime accepts compiled AST only. User strings
  remain literal values; adapters must render output as text, never HTML or ICU.
- Missing/broken selected messages try the English AST, then `SAFE_MESSAGE`, which
  is independent of all catalogs. Unknown keys or invalid arguments use the same
  safe message. Diagnostics contain only a code and optionally a registered key;
  FormatJS errors, source strings and argument values never enter the observer.
- Each service owns formatter caches. P0-2 composes it into
  `createLocaleService(context)` and recreates it after locale/catalog changes;
  locale preference/matching, regional formats and timezone rules belong to P0-2.
- P0-3 awaits `loadMessageCatalog` before switching the web context. Korean uses
  a separate Vite chunk; English is the bundled fallback. P0-4 packages both
  catalogs for offline switching and initializes required Intl polyfills first.
- P0-5 may supply its literal-transformed `MessageCatalog`; its pseudo generator
  and CI wiring are separate. P0-6 uses the nonempty `messageKeys`/`argumentSpecs`
  exports to connect the existing copy testkit. Neither tool is wired here.

FormatJS lifecycle and precompiled AST references:
[intl API](https://formatjs.github.io/docs/intl/),
[precompilation](https://formatjs.github.io/docs/guides/advanced-usage/).

## P0-2 — device preference and shared format context (#4831)

`createLocalePreferences(port)` awaits the installation's stored `system` or
supported BCP 47 ID. P0-3/4 implement `readPreference`, `writePreference` and
`readDevice` on a `LocalePreferencePort`; core never reads platform globals or
storage. Keep this port/service outside account and workspace lifecycles, and
keep its value on logout/removal. Writes are serialized and published only after
successful persistence. `refresh()` rereads device facts on resume/OS changes;
`subscribe()` supplies the new immutable preference/context snapshot.

`matchDeviceLocale` canonicalizes tags independently and scans OS order for
ko-KR, en-US, ja-JP, zh-Hans, zh-Hant, es-419 or fr-FR, then defaults to en-US.
Chinese scripts take priority over region; TW/HK/MO imply Hant without a script.
These are supported language IDs, **not a claim of translated catalog coverage**:
only ko/en catalogs ship in P0-1. Adapters show the ADR's partial-support notice
and load available catalogs before rendering a changed context.

`resolveLocaleContext(preference, device, explicitTimeZone?)` returns
`messageLocale`, regional `formatLocale`, `timeZone`, `hourCycle` and
`weekStartsOn`. It preserves a host-supplied region, or the matching device tag's
region (otherwise the first tag/default region), under the selected language.
Chinese defaults to CN/TW; Spanish defaults to 419. A valid explicit device week
setting (ISO Monday=1 through Sunday=7) wins, otherwise the small regional map
uses [CLDR release 49 weekData](https://github.com/unicode-org/cldr/blob/release-49/common/supplemental/supplementalData.xml),
without `Intl.Locale.weekInfo`. Timezone precedence is valid explicit IANA choice,
device IANA zone, UTC; adapters must not pass a member's default UTC as an
explicit user choice. Language selection never rewrites stored timestamps.

```ts
import { createLocalePreferences, createLocaleService, loadMessageCatalog } from '@momo/core/i18n';

// The host owns this installation-scoped port, including OS regional settings.
const preferences = await createLocalePreferences(port);
const { context } = preferences.getSnapshot();
const catalog = context.messageLocale === 'ko-KR'
  ? await loadMessageCatalog('ko-KR') : undefined;
const locale = createLocaleService({ ...context, catalog });
locale.formatMessage('common.members.count', { count: 2 });
locale.formatTime(message.createdAtMs); // epoch input, context zone/hour cycle
locale.formatCurrency(cost.amount, cost.currency); // API ISO 4217 code required
```

`createLocaleService(context)` combines generated-key messages, basic dates/time,
numbers/percentages, explicit-currency formatting and cardinal/ordinal plurals.
`formatRelativeTime(epoch, now, unit)` takes a shared injected now; `day` compares
context-zone calendar days across midnight and DST. `compareDisplay` takes
explicit Collator options, normalizes NFC and breaks equivalent labels by stable
ID; it is for display lists, never message seq/server search/page order.

After loading the catalog, adapters call `updateContext({...next, catalog})`;
it replaces message instances and all regional formatter caches, then notifies
subscribers. Cache keys include locale, timezone and options; each regional cache
is capped at 64 entries. Regional errors try English/UTC, then the existing
catalog-independent `SAFE_MESSAGE`; failed plural rules return `other` and failed
collation uses deterministic text/ID order. Diagnostics contain only codes and
registered message keys; throwing observers cannot interrupt fallback or switches.
No runtime dependency, polyfill or UI adapter is added. P0-4 must initialize its
Intl prerequisites before constructing these services.

Known follow-up (independent review, Medium): direct `formatTime` honors the
context hour cycle, while an ICU time argument currently uses the locale's
default hour cycle. The existing P0 catalog has no time argument. Before adding
one, pass the context hour cycle through the message formatter too; timezone
and regional locale already reach ICU date/time arguments.

P0-2 validation on the resumed patch:

- Core typecheck, `eslint src/i18n`, `gate:purity`, `gate:copy`, `i18n:check`
  and `git diff --check`: PASS; no dependency/lockfile changes.
- Added behavior tests: 14 PASS. Independent fresh code review: Blocker 0,
  High 0, Medium 1 (hour-cycle follow-up above); isolated locale/context/service
  tests: 21 PASS.
- Isolated matching, timezone and formatter-cache sabotage each produced an
  assertion failure; the workspace implementation was never mutated.
- `npm --prefix packages/momo-core test`: run once at the end, 273 files PASS,
  6,736 tests PASS, 1 existing todo. `scripts/tests/test_pr_ci_guardrails.sh`: PASS.
- Stack verification memo: no screen changed; after P0-3/4, rerun profile-language
  Playwright/Maestro paths for ko/en/system, partial support, failed load/retry,
  restart/offline, app resume/OS language change and account/workspace switching.
  Check regional dates, midnight/DST, explicit timezone, currency and plural
  probes on Hermes. UI/design review, release runtime and merge-tree/full-stack
  gates remain planner-owned (`runtime-unverified` for actual Hermes/hosts).
  No Rust input, simulator, Xcode, Docker, capture, commit, push or PR was added.

## Dependencies and attribution

Direct dependencies are exactly `@formatjs/intl@6.1.4` (runtime) and
`@formatjs/icu-messageformat-parser@3.5.22` (generator devDependency), as pinned
by ADR-0213. The runtime closure also contains `intl-messageformat@12.1.4`,
`@formatjs/fast-memoize@3.1.7` and `@formatjs/icu-skeleton-parser@2.1.12`.
The parser is a transitive runtime dependency even with precompiled messages;
there is no parser-removal alias in this change. No CLI, React adapter, macro,
polyfill or additional locale-data package was added.

`node scripts/check_npm_licenses.mjs --report <temporary-report>` passed for all
**1,845 packages across the workspace, web and mobile lockfiles**, including
development and transitive dependencies. The five new packages are MIT or
BSD-3-Clause. [The core NOTICE](../../NOTICE) preserves each exact version and
its complete upstream license text. This package notice must accompany future
client redistribution; the existing GHCR bundle inventories the web lockfile,
not the workspace's new runtime graph.

## Size evidence — same HEAD, controlled import

Measured on `83c02bc6c136186f5312e2ff2da2feeb335406a5` with this uncommitted
P0-1 patch, Node 24.14.0, Vite 6.4.3, Metro 0.84.4 and Hermes compiler
250829098.0.16. Both phases use the full product entry and the same settings.
Only the after phase injects a temporary probe retaining the service plus ko/en
catalogs and rendering the language row and a plural. Product entry files are
never edited. Actual product bundles do not import P0-1 until the adapter work.
Gzip totals compress each JS/CSS file independently at level 9.

| Measurement (bytes) | Before | After | Delta |
|---|---:|---:|---:|
| Web Vite production JS + CSS | 4,652,335 | 4,703,522 | +51,187 |
| Web Vite production gzip | 1,323,322 | 1,338,215 | +14,893 |
| Metro iOS release JS, with prerequisites below | 3,748,460 | 3,808,281 | +59,821 |
| Metro gzip, with prerequisites below | 990,587 | 1,007,385 | +16,798 |
| Hermes `-O -emit-binary`, with prerequisites below | 5,344,103 | 5,432,273 | +88,170 |

The after graphs include all five FormatJS modules, including the runtime parser.
Neither graph includes `i18n/tooling` or TypeScript. ko/en AST, the generated key/
argument metadata and the wrapper are included; polyfill/locale-data cost is **not**.

Reproduce from the repository root:

```sh
node packages/momo-core/src/i18n/tooling/measure-bundles.mjs web
node packages/momo-core/src/i18n/tooling/measure-bundles.mjs mobile
node packages/momo-core/src/i18n/tooling/measure-bundles.mjs mobile --include-workspace-node-modules
node packages/momo-core/src/i18n/tooling/measure-bundles.mjs mobile --include-workspace-node-modules --transform-class-static-block
```

The shipping Metro configuration is **runtime-unverified** for this new graph:
without workspace `node_modules` in `watchFolders`, it silently serializes the
FormatJS dependency as `null`. The probe now rejects that misleading measurement.
Adding just the temporary watchFolder exposes another integration prerequisite:
the locked `intl-messageformat@12.1.4` static class blocks fail the current RN
Babel preset. The last command adds an isolated temporary transformer using the
**already installed** `@babel/plugin-transform-class-static-block`, in both phases,
and produced the valid conditional numbers above. No mobile configuration or
dependency was changed. P0-4 must integrate these two prerequisites, include any
needed Intl polyfills, and repeat shipping release measurements. Bytecode
compilation is not actual Hermes execution or an installable app size result.

## Validation and planner handoff

- `npm --prefix packages/momo-core run typecheck`: PASS.
- `npm exec --workspace @momo/core -- eslint src/i18n`: PASS.
- `npm --prefix packages/momo-core run i18n:check`: PASS.
- `npm --prefix packages/momo-core test`: **270 files PASS; 6,688 tests PASS,
  1 existing todo**, run once after implementation and review fixes.
- `npm --prefix packages/momo-core run gate:copy`: PASS, including name checks.
- Lockfile license gate: PASS, all three canonical npm roots as above.
- `git diff --check`: PASS.
- 14 added behavior tests include duplicate/blank/missing keys, invalid ICU,
  missing `other`, argument rename/type sabotage, nested select/ordinal/date
  inference, prototype-named arguments, stale AST, broken/missing selected
  catalogs, unknown IDs, invalid runtime arguments, literal user values, missing
  Intl.PluralRules, redacted diagnostics and throwing observers.
- Independent fresh code review found a prototype-name generation defect; it
  was fixed with a null-prototype accumulator and regression assertions. Follow-up
  independent review reported no remaining material findings.
- `gate:purity` allows exactly `@formatjs/intl@6.1.4` as the core's one runtime
  dependency (Accepted ADR-0213), imported only under `src/i18n`;
  `@formatjs/icu-messageformat-parser` stays a development dependency that
  `src/i18n` may import as types only. Any other dependency, version or import
  site still fails the gate.

Stack verification memo: no screen changed here. After P0-3/4 land, rerun the
settings/profile language Playwright and Maestro paths: ko/en/system selection,
partial-support notice, language-load error/retry, reload/offline/restart,
all accounts/workspaces and literal names, large type, keyboard/focus and reduced
motion. Include missing-key/Intl-safe paths and ADR-0213's actual Hermes plural
probes (0/1/2/1.5/1,000,000). UI capture, design review, merge-tree/full stack gates
and actual Hermes execution are deferred to planner; no simulator, Xcode, Docker
or capture was used. No Rust `include_str!` input was added. No commit/push/PR
was made; planner owns those delivery steps.

## P0-5 — pseudo locale (#4834, #5589)

`pseudo.ts` exports `pseudoCatalog(compiledCatalog)` and `PSEUDO_LOCALE` (`en-XA`). It clones ICU
ASTs, accents only literal characters, adds `[` / `]` boundaries, and expands the total literal
length by 35%, including markers. Padding is placed at word ends (#5589), so a long message keeps
its line-break opportunities; one unbroken `~` run would report overflow no real language causes.
Labels shorter than 7 code points and argument-only messages cannot always fit the 30–40% band
while retaining both markers. For branching messages the budget covers all branch literals.
Keys, arguments, selectors, plural offsets, pound, tags and number/date skeletons are preserved.
The module reads the parser's AST type numbers as plain constants (pinned by `pseudo.test.ts`), so
it never loads the parser at runtime. `tooling/pseudo.mjs` re-exports it with the parser's
`parse`/`TYPE` for tests.

It is **not exported from the `@momo/core/i18n` barrel** and no language list offers it. The web
client loads it only in development and `--mode design` builds (`clients/web/src/i18n/pseudoLocale.ts`,
`?pseudo=1` per tab); a production build contains neither the module nor the switch. The capture
lane `npm --prefix clients/web run capture:pseudo` renders representative screens in pseudo mode and
counts visible text that is not bracketed (did not come from the dictionary). Never commit a pseudo
catalog to `generated/`.

## Seven catalogs (#5589, ADR-0213 §2)

`catalogs/<locale>/` exists for all seven ADR-0213 languages. `ko-KR` and `en-US` are **complete**:
same keys, and together they define the key/argument contract (`generated/messages.ts`). `ja-JP`,
`zh-Hans`, `zh-Hant`, `es-419` and `fr-FR` are **drafts**: each mirrors the en-US feature files,
keys may be missing or blank (blank = untranslated and left out), and a present key must keep the
en-US argument names, with each argument either bare or of the contract's type. The generator emits
`generated/<locale>.ts` for all seven and `loadMessageCatalog` has one chunk per language. At runtime
a missing draft key shows English and reports `missing-message` (the service's existing fallback).
The user-visible language list stays ko/en (web/mobile `availableLocales`) until P2's native review.

ICU plural (CLDR categories per language, e.g. French/Spanish `many`), number and date arguments
compile for drafts the same way; `generation.test.ts` proves it on a fixture root, not the product
catalogs (translations are P2).

## P1 migration — the one pattern every copy cell follows (#6020)

This section is the whole contract for a cell that moves screen copy into the dictionary. Read it instead of the
rest of this file. The finished specimen is `features/readState/copy.ts` and `features/huddles/huddleModel.ts` in the
core, `clients/web/src/features/huddles/*`, and their callers in `clients/web/src/features/timeline/`. A web key table lives in its own `.ts` file (`huddles/micKeys.ts`):
exporting it from a component file trips `react-refresh/only-export-components`.

### Steps of one cell

1. Pick the catalog file for your copy from the table in **Catalog files**. Add each sentence to `catalogs/ko-KR` and
   `catalogs/en-US` next to its related keys. A new file also needs `{}` in the five draft directories.
2. `npm --prefix packages/momo-core run i18n:generate`. Commit the regenerated `generated/*.ts` with the catalogs.
3. Replace the literals using the shapes in **One shape**. Move the Korean **verbatim**: the Korean screen must not
   change by one character (wording fixes are separate issues). English is short, direct and sentence case.
4. `node packages/momo-core/src/i18n/tooling/direct-copy.mjs shrink`, then `… check`. Delete the raises your change
   made unnecessary. Your files' rows must reach `{"ko": 0, "en": 0}` (and `cat` 0 where it was counted).
5. Fix the tests as described in **Tests**.
6. Run the core vitest suite in full once (it holds the key/table equality tests), the web/phone tests you touched,
   the three typechecks, `i18n:check`, and `bash scripts/design_preflight_web.sh` (core copy rules) right after
   adding keys. If a gate rejects a verbatim Korean sentence, stop and report it; do not rewrite copy to pass.

### Shared words (`common.*`)

Counted, not picked: every Korean literal the ledger counts on the three surfaces (10,862 at `7a41b2a90`), grouped
by exact text. A word became a shared key only if it appears at least 9 times on at least two surfaces **and** has
one English rendering everywhere (the existing catalog was the test: the same Korean already translated two ways is
two meanings). `연결 안 됨` (7) joins as the pair of `연결됨`, a house word.

| Key | 한국어 | English | Uses (core / web / phone) |
|---|---|---|---:|
| `common.action.retry` | 다시 시도 | Try again | 79 (14 / 59 / 6) |
| `common.action.cancel` | 취소 | Cancel | 60 (15 / 40 / 5) |
| `common.action.close` | 닫기 | Close | 63 (12 / 42 / 9) |
| `common.action.reload` | 다시 불러오기 | Reload | 29 (6 / 11 / 12) |
| `common.action.checkAgain` | 다시 확인 | Check again | 14 (2 / 11 / 1) |
| `common.action.save` | 저장 | Save | 10 (1 / 5 / 4) |
| `common.state.saving` | 저장 중 | Saving | 19 (2 / 14 / 3) |
| `common.state.checking` | 확인 중 | Checking | 17 (3 / 12 / 2) |
| `common.state.loading` | 불러오는 중 | Loading | 9 (1 / 8 / 0) |
| `common.state.creating` | 만드는 중 | Creating | 9 (1 / 8 / 0) |
| `common.state.sending` | 보내는 중 | Sending | 9 (1 / 4 / 4) |
| `common.state.connected` | 연결됨 | Connected | 12 (7 / 4 / 1) |
| `common.state.notConnected` | 연결 안 됨 | Not connected | 7 (5 / 1 / 1) |

Use the shared key whenever the screen's word **and** its English are the ones above; do not add a feature key for
them. Left out on purpose:

- One Korean word, two English words today: 닫기 for a notice (`Dismiss` — the dialog/panel sense `Close` is shared),
  더 보기 (`Load more` / `Show more` / `See more`), 지우기 (`Remove` / `Delete`), 다시 보내기 (`Resend` /
  `Try again`), 확인 (`OK` / `Got it`), 완료 (button `Done` / state `Completed`), 에이전트 (`Agent` / `Agents`),
  실패 · 거부 · 승인 · 대기 (an action and a state).
- Counters and joining pieces — 개 · 일 · 월 · 외 · 명 · 건 · 분 · 시간 · 초 · 까지. They are debris of assembled
  sentences; each becomes an ICU argument inside its own sentence (`{count, number}명`), never a key.
- Domain nouns (채널, 워크스페이스, 라이트, 다크, 상태, 기본, 전체): they belong to their feature's file and wording.

The catalog already holds feature keys with these exact words (다시 시도 ×13, 취소 ×13, 닫기 ×7, 복사됨 ×4).
They stay; folding them into `common.*` touches about 40 call sites across bundles and is a follow-up, not part of
any cell.

### One shape: the core returns keys, the screen formats

The core never returns a sentence. It returns a key (`PlainMessageKey`) or a key with values (`MessageRef`), both
from `i18n/keys.ts`; the screen formats with `formatMessage` when it draws, in the language it is showing. This is
what the newest core models already do (`channels/rename.ts`, `browse.ts`, `connection/copyKeys.ts`); at #6020,
20 core files carried keys and 19 took a formatter, so the key shape is the one kept.

| What the old code is | New shape | Specimen |
|---|---|---|
| Constant: `export const X_LABEL = "…"` | `export const X_KEY = "feature.surface.intent" satisfies PlainMessageKey;` → caller `formatMessage(X_KEY)` | `MARK_UNREAD_ACTION_KEY` |
| Closed enum → sentence (`switch`) | Table `as const satisfies Record<Kind, PlainMessageKey>` (compile stops on a missing kind) | `HUDDLE_ERROR_KEYS` |
| Logic → sentence (status codes, branches) | Same function, returns `PlainMessageKey` | `markUnreadFailureKey` |
| Sentence with a name or a count | Returns `MessageRef<K>`, one key per sentence form; never join pieces with `,` or `외` → caller `formatMessage(ref.key, ref.values as never)` | `huddleParticipantSummary` |
| Sentence kept in React state | State holds the key; format where it renders (switching language updates a standing banner) | `useHuddle` `notice` |
| Same, but the state is shared with copy another cell still owns | Format when setting, with a comment; the cell that moves the last sentence turns the state into a key | `MessageRow` `setRowError` |
| Sentence carried in `throw new Error(…)` | Rethrow the original error; the display site maps it to a key | `useMarkUnread` → `MessageRow` |
| Web/phone model that builds a list of labels | Item gets `labelKey` and a resolver (`messageActionLabel`); the cell that moves the rest of that model drops `label` | `messageActionModel.ts` |

The single exception: when building a **value** needs the locale service (`formatTime`, `formatDate`,
`formatNumber`, `formatRelativeTime`, or another message), the function takes the formatter or `LocaleService` as its
first parameter and returns the string (`timeline/editedLabel.ts`). Ask one question per function: "does any value
need the locale?" No → key shape. Yes → this exception. Nothing else.

Do not wrap `formatMessage` in a helper with another name: the ledger recognises only that callee (unknown keys,
`cat` joins). Strings that are message keys are not counted as English copy, so key tables need no exemption.
The `as never` on `values` is the existing idiom; the values were type-checked against the key where the ref was built.
Phone screens already consume refs the same way (`clients/mobile/src/features/sidebar/RenameChannelBody.tsx`,
`screens/ChannelBrowseScreen.tsx`).

### Catalog files

The generator requires the first key segment to equal the file name, so a prefix **is** a file. Merging measured at
#6020 on four throwaway branches: keys added to two different files merge cleanly and the merged `generated/` is
already fresh; two branches adding to the **same** file (new or existing) conflict in the JSON and in all three
generated files, and the landing train drops a cell whose conflict is outside `generated/` and the ledger. So:

- **One open cell per catalog file.** Cells of one bundle run one after another; bundles may run side by side because
  their files below do not overlap.
- Phone-only copy goes into the bundle's feature file, not `mobile.json` (shared by every phone cell; its existing
  keys stay).
- Keys are `feature.surface.intent`: the surface is the component or area (`huddles.mic`), the intent a camelCase
  meaning (`permissionDenied`), never the Korean text or a line number.

| Bundle | Cells | Catalog files (= key prefixes) |
|---|---|---|
| A 대화 | L-A1 → A2 → A3 → A4 | `timeline` (core timeline, web timeline, phone conversation and its screen), `reply`, `scheduled`, `attachments`, `reminders`, `chat`, `emoji`, `drafts`, `huddles`, `readState` |
| B 길찾기 | L-B1 → B2 → B3 | `inbox`, `presence`, `sidebar`, `channels`, `directory`, `memberList`, `search`, `workspace`, `notifications`, `connection` (network state, incl. core `lib/http.ts`), `updates`, `downloads`, `activity`, `pwa`, `home`, `push`, `shell` |
| C 가입 · 연결 | L-C1 → C2 | `auth`, `onboarding`, `cliLogin`, `welcome`, `deviceKey`, `aiConnect`, `connect`, `recovery` |
| X 표현 | L-X1 | `expressions` |
| F 작업 | L-F1 → F2 → F3 → F4 | `workbench`, `work`, `workstreams`, `workTab`, `workConsole`, `ade` |
| D 설정 · 앱 | L-D1 → D2 → D4 → D5 → D6 → D8; L-D3 → D7 | `settings` (core and web settings, phone profile), `appearance` (themes, phone `design/`), `github`, `capabilities`, `plugins`, `commands`, `webhooks`, `app`, `desktop`, `appUpdate` |
| E 에이전트 · AI · 기억 | L-E1 → E2 → E3 → E5 → E6; L-E4 | `ai`, `hostedAgents`, `agents`, `routing`, `approvals`, `agentHub`, `decisionStage`, `aiHub`, `teamAi`, `memory` |
| (shared) | L-0 only | `common` — later cells only read it |

`connection.*` is network state (#5219); do not put other failures there. Core `lib/` is split by meaning, not by
folder: `http.ts` → B (`connection`), `serverUrl.ts` → C (`auth`), the tool-permission sentences in `api.ts` → E
(`agents`). A cell that needs a sentence owned by another bundle's file uses a shared key or adds one to its own file.

### Not copy

- **Design gallery** (`clients/web/src/design/Gallery.tsx`, 119 ko / 27 en including raise #5782): exempt. It is
  loaded only when `import.meta.env.MODE === "design"` or `VITE_DESIGN_GALLERY=1` (`clients/web/src/app/App.tsx`,
  `DESIGN_GALLERY_ENABLED`); production builds never contain it, and its literals quote product copy as specimens. Its
  counts already sit in the anchor, so it needs nothing now; "P1 done" means every ledger row is 0 **except this one
  file**. New specimen copy there uses the existing `raise` with a reason, as #5782 did. There is no exemption list in
  the tool. `design/themes/index.ts` (5) names themes a person picks, so it is copy (cell L-D8).
- **Text no person sees** (developer `Error`s that only reach logs, dev-only switches): write it in English
  diagnostics. That removes the `ko` count honestly; English in an `Error` is not counted.
- **Language data**: `lib/koreanParticle.ts` (23) holds particles and Sino-Korean digits, the Korean-only formatter
  ADR-0213 §4 confines to the translation layer. It is not a sentence and cannot reach 0 by moving copy; whether it
  is excluded like `autonyms.ts` is a ledger policy change for the planner. Until then its row stays as it is.
- **User data** (names, channel names, device labels from the OS) is a value, never a key. A name list is a sentence
  with arguments (`huddles.participants.*`), not a `join(", ")` plus a counter.

### Tests

- **Core**: bind the dictionary with `createMessageCopy({messageLocale: "ko-KR", catalog})` (`@momo/core/testkit`) and
  keep asserting the same Korean sentence, so the wording guard stays (`readState/copy.test.ts`). It throws on an
  unknown key or bad values.
- **Web**: a screen mounted without a locale provider renders the **bundled English** (`useFormatMessage`). A test
  that guards Korean wording wraps the screen with `koreanLocale()` (`src/testing/koLocale.ts`); a test about
  structure asserts the English, written out by hand (`HuddleHeaderNames.test.tsx`).
- **Phone**: `useFormatMessage` falls back to **Korean**, so most phone tests keep passing unchanged.
- **Source-reading tests** that pin a Korean literal in code (`ChatShell.header.test.ts`) now pin the key.
- A test that compared a hook's thrown `error.message` with a sentence now checks the key the display site uses.

### Particles, numbers, dates

- No `koreanParticle` / `attachParticle` in a moved sentence (ADR-0213 §4). Use a Korean template whose particle does
  not depend on the name: `{name} 님이`, `{name}에게`, `{name}의`. If no such wording keeps the meaning, stop and
  report; do not move the particle call into the dictionary path.
- Counts are ICU arguments: Korean `{count, number}명`, English `{count, plural, one {# member} other {# members}}`.
  Never branch on `count === 1` in code.
- Times and dates are formatted with the locale service and passed as a string argument (an ICU time argument ignores
  the hour cycle — see P0-2's known follow-up). Hard-coded `"ko-KR"` in `toLocale*String` inside a cell's files is
  part of that cell (ADR-0213 §9 P1-5 · P1-8).

### Generated files and landing

`generated/*.ts` is always regenerated and committed with the catalogs; never edit it by hand. When branches meet,
the landing train resolves conflicts in `generated/` and the ledger by regenerating after the merge; a conflict in a
catalog JSON is not resolved automatically, which is why a file has one open cell. A single PR updated from its
track (`update-branch`) gets a clean merge when its files are its own, and PR CI's `i18n:check` proves the merged
`generated/` is fresh.

### Measured at #6020

- 13 shared keys added; `PlainMessageKey` (three private copies before) and `MessageRef` now live in `i18n/keys.ts`.
- Specimen: core `readState/copy.ts` 5 → 0, `huddles/huddleModel.ts` 11 → 0; web `features/huddles` 21 ko + 1 en → 0.
  Surfaces: core 5,331 → 5,315, web 4,095 → 4,074 (en 125 → 124), phone 1,436 (no phone call site in this folder).
- Time: 37 literals took about 11 minutes from the first edit to green touched tests (about 8 editing, 3 fixing six
  test files), on top of the design work. Test churn, not catalog writing, is the larger share.

## Direct-copy ratchet (#4834, redesigned by #5589)

`tooling/direct-copy-baseline.json` (version 2) is the ledger of hardcoded copy outside the
dictionary. **It only goes down.** Before #5589 the landing chain re-emitted the whole ledger at
every landing, so new copy became allowance unreviewed (since 10-30: core +226, web +26, phone +51
Korean literals by the 11-09 count). The format below makes that path fail.

| Field | Meaning | Who writes it |
|---|---|---|
| `anchor` | Frozen per-file counts at `anchorHead`. Its sha256 is pinned in `direct-copy.mjs` (`ANCHOR_SEAL`). | Planner only, by a deliberate re-anchor (`anchor <commit>` prints the ledger and the seal; the seal edit is a reviewed code change) |
| `lowered` | Files whose allowance went down since the anchor. Never above the anchor. | `shrink`, `land` |
| `raises` | One file, one issue number, one reason each; the only way a count goes up. A reason must say why the copy waits for P1 — a regeneration/refresh note is rejected. | A person, through `raise` |

Allowed count per file = (`lowered` ?? `anchor`) + Σ `raises`, per dimension:

- `ko` — Hangul literals anywhere in product code, including `Error` messages (diagnostics are written
  in English, so Korean in one reaches a person) and the values handed to a message
  (`formatMessage(key, {label: "…"})`). Not counted: comments, types, imports, `console`/`logger`/`log`
  calls, a message key or frame name. The core skips only the dictionary itself (`src/i18n/catalogs/`,
  `generated/`, `tooling/`) and the language self-names (`autonyms.ts`).
- `en` — English **copy**, by one rule on every surface: JSX text and `{…}` children, copy-named
  attributes/properties/variables (`title`, `aria-label`, `placeholder`, `headline`, `*Label`, `*Text`, …)
  and alert/toast/`setError`-like calls. The nearest thing that names a literal's role decides. A literal
  that is compared (`kind === "dm"`, `case "idle":`), passed as an argument (`toLocaleString("ko-KR")`,
  `failureMessage("list", e)`, `setStatus("loading")`), used as an index, or sits in a style object is not
  copy; neither is English in an `Error` or a message argument. A string literal that **is** a key of the
  en-US catalog is a message key, not copy, wherever it sits (`title: "releaseNotes.v0145.summary"` in a
  release-notes file, `offlineTitle: "connection.card.offlineTitle"` in a key map): the catalog decides
  by exact match, never the dotted shape, so `"momo.message"` or a key the catalog lacks still counts.
  Only the feature files directly in `catalogs/en-US/` (the ones `generate.mjs` reads and holds to the key
  shape) give keys; a JSON in a subfolder does not, so it cannot hide English copy.
  `anchor <commit>` reads that commit's catalog, so it gives the same seal from any checkout. Until
  #5589's fix rounds the clients counted any one-word literal (about 90% class names and state words) and
  the core counted its key maps (119 of 168 core `en`); a strict ratchet turns that noise into landing
  stops.
- `cat` — sentences assembled from dictionary output: a `formatMessage(...)` inside a template with
  other text or another span, `formatMessage(...) + …`, or `[formatMessage(...), …].join(…)`.
  Translate the whole sentence as one key with arguments instead (ADR-0213 §4).

JSX attributes count too (#5589): Korean in **any** attribute except technical ones (`className`,
`testID`, `data-*`, `id`, `href`, `role`, …), and English in copy-named ones (`title`, `aria-label`,
`placeholder`, `headline`, `detail`, `*Label`, `*Text`, `*Title`, …). This closed a blind spot of
305 web and 110 phone Korean literals (`headline`, `actionLabel`, `detail`, `legend`, `busyLabel`…).
An attribute is judged by its name however the value is computed: a literal reaches it through
ternaries, `&&`/`??`, calls such as `cn(…)`, templates and arrays, so `className={cn("flex", open && "hidden")}`
and ``data-testid={`row-${id}`}`` count nothing. `name` is not technical for Korean, because components
show it (`SettingsToggleRow name="…"`). An object property inside an attribute is judged by its own
name (`action={{label: "…"}}` is copy).

The scan must equal the allowance exactly: higher fails with "use a dictionary key, or add one
explicit raise"; lower fails with "run `shrink`", so a later addition cannot spend a stale budget.
`check` reads no git and runs in each tree's `npm test` (core `direct-copy.test.ts`, web
`src/testing/directCopy.test.ts`, mobile `__tests__/directCopy.test.ts`) and in `i18n:check`.

PR CI's core job also runs `check` on all three surfaces and compares the ledger with the **base of the
PR merge ref** — the merge commit's first parent, i.e. the track tip that run merged (`compare-base`,
after fetching that one commit). Not GitHub's `pull_request.base.sha`: that is the merge-base, so once
the track moved it would list another PR's raises as this PR's and go RED after an approved re-anchor
(#5598 review r2; `direct-copy-ci.test.ts` runs the workflow step on a shallow merge ref). The anchor, `anchorHead` and `ANCHOR_SEAL` must equal the base's unless the PR carries the
`policy-change-approved` label (a re-anchor edits `direct-copy.mjs`, a policy path, so it needs that
approval anyway), and no file's `(lowered ?? anchor)` may go above the base's. It prints the new raises
file by file. `land --check` is not run in CI: CI runs on the PR merge ref, where an auto-merged ledger
would differ byte for byte without anything being wrong.

```sh
node packages/momo-core/src/i18n/tooling/direct-copy.mjs check            # core, web, mobile
node packages/momo-core/src/i18n/tooling/direct-copy.mjs shrink           # lower only; refuses if anything went up
node packages/momo-core/src/i18n/tooling/direct-copy.mjs raise <file> --issue <N> --reason "<why it waits for P1>"
node packages/momo-core/src/i18n/tooling/direct-copy.mjs land --base origin/<track> --ours <branch tip> [--check] [--allow-many-raises]
node packages/momo-core/src/i18n/tooling/direct-copy.mjs compare-base <merge ref base>  # PR CI; base must be fetched
node packages/momo-core/src/i18n/tooling/direct-copy.mjs report           # totals per surface (scan and anchor)
node packages/momo-core/src/i18n/tooling/direct-copy.mjs anchor <commit>  # planner only: prints a new ledger + seal
```

`land` replaces the old landing re-emission. It derives the merged ledger from the **target track's
committed ledger** plus the branch's **new raise entries** (never from the working copy, so a
conflict resolved with `--theirs` cannot smuggle counts in), then lowers it to the merged scan.
Anything the scan has above that is copy neither side justified: `land` writes nothing and fails.
It also fails when a scanned file has unstaged changes or is untracked (it counts the working copy,
which must be what will be committed; a staged merge resolution and generated output are fine), and
when one landing would carry more than 10 new raises (`--allow-many-raises` is an explicit decision,
listed in the PR body). It prints every raise it carries.

**After `land` stops a landing** (copy neither side justified): in the chain's merged state — the
landing worktree after it merged the track — move the copy to a dictionary key or add the raise,
**commit**, then run the chain again. `land` reads raises from the committed branch tip (`--ours`),
never from the working copy, so an uncommitted raise is ignored (it prints a note). A branch made
before #5589 has no `raise` command; run it from the merged state, where the v2 tool is present.

What the ratchet guarantees: **growth is not blocked; it shows up file by file in the ledger diff.**
Every increase is a raise naming one file, a 4–5 digit issue and a reason (a reason about the ledger,
a merge or a sync is refused), PR CI prints the new raises, and `land` prints them and stops past 10.
Whether an issue number exists cannot be checked offline; reviewers read the raises in the diff.

A rename moves copy to a new path: `shrink` lowers the old path once the new path has a raise whose
reason names the move. A new en-US feature file needs the same file (an empty `{}` is fine) in the
five draft directories; `i18n:check` names the missing ones.

Known limitation (from #4834): the scanner recognises `formatMessage(...)` only by that callee name.
An alias such as `const t = locale.service.formatMessage; t("settings.profile.languageLabel")` is not
counted (the key is a call argument), but it also skips the unknown-key check; `cat` likewise misses
concatenations through an alias. A raised `lowered` value inside the anchor cannot be seen from the
tree alone; PR CI's `compare-base` refuses it against the base, and `land` never carries a branch's
`lowered`.

Known limitation (#5598 review, M3): `cat` catches only direct joins — `formatMessage(...)` in a
template with other text, `formatMessage(...) + …`, `[formatMessage(...), …].join(…)`. It misses a
message kept in a variable and joined later, JSX siblings (`{formatMessage(k)} {n}`), `.concat()`,
`String(formatMessage(k)) + n`, aliases, and two messages side by side in JSX. The counted places are a
lower bound. **P1 review checklist item:** no sentence is assembled from a message and other text or
another message, however it is joined; it becomes one key with arguments.

P1 migration lowers counts (`shrink`) and deletes the raises it makes unnecessary. Replacing a literal
with a key that is in the en-US catalog lowers `ko` and adds no `en`; add the key to the catalog in the
same change. Re-anchoring is
for the planner at a stack boundary (to fold reviewed raises and lock in reductions), never to absorb
unexplained growth. Extracted copy text and user data are never written to the ledger.
