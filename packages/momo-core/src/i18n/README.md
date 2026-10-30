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

## P0-5 — pseudo locale and direct-copy CI (#4834)

`tooling/pseudo.mjs` exports `pseudoCatalog(compiledCatalog)` for development and
stack QA. Pass its result to `createMessageService({messageLocale: 'en-XA', catalog})`.
It clones ICU ASTs, accents only literal characters, adds `[` / `]` boundaries,
and expands the total literal length by 35%, including markers. Padding rounds
to whole Unicode code points; labels shorter than 7 code points and argument-only
messages cannot always fit the 30–40% band while retaining both markers. For
branching messages the budget covers all branch literals, rather than the length
of runtime argument values. Keys, arguments, selectors, plural offsets, pound,
tags and number/date skeletons are preserved. Tags remain subject to P0-1's
approved-adapter restriction. This tool and its output are **not exported or
loaded by product entries**; never commit a pseudo catalog to `generated/`.

Existing `generation.test.ts` already runs the P0-1 compiler with `check: true`
under core `npm test`: missing/blank keys, ICU parsing, argument name/type mismatch
and stale generated files fail there. No second validator or workflow change is
needed. `pseudo.test.ts` proves AST preservation and real service formatting.

`tooling/direct-copy-baseline.json` records the fixed starting HEAD
`078f76b1056191fdfc1664f9c837ffa6fbf0482c` and **file → occurrence count** for
web/mobile production JS/TS sources (including mobile `App.tsx`/`index.js`).
`tooling/direct-copy.mjs` uses the existing
TypeScript parser, not a Korean-only regex: JSX text, accessible names, known copy
properties, Korean literals, English phrases and standalone English words are
counted, including template segments. This deliberately conservative English
rule also budgets standalone technical enum words. Comments, imports/types,
property names, non-copy JSX attributes, diagnostic calls (`console`, `logger`,
`log`, Error constructors/assertions), test/fixture/testkit files, generated files
are excluded. Product design controls remain included. Dynamic user content has
no literal to count;
message keys/arguments are validated by the dictionary and typed service instead.
Literal `formatMessage` references are checked against every English feature JSON.

One test in each client's existing `npm test` invokes the scanner with Node.
**Increases fail per file**, including previously absent files. Reductions also
fail with an instruction to shrink that file's committed allowance (remove zero
entries), preventing future copy from spending stale budget. Moving lines leaves
counts unchanged. Equal-count replacement is intentionally not a content diff;
review must still enforce dictionary-only new user copy. This does not migrate
existing screen copy (P1), inspect shared-core copy, or infer runtime/dataflow
strings. Extracted copy text and user data are not written to the ledger.

```sh
node packages/momo-core/src/i18n/tooling/direct-copy.mjs web
node packages/momo-core/src/i18n/tooling/direct-copy.mjs mobile
# Audit/reproduce the original baseline; emit only, never auto-update allowances:
node packages/momo-core/src/i18n/tooling/direct-copy.mjs --baseline 078f76b1056191fdfc1664f9c837ffa6fbf0482c
```

For P1, lower only the migrated files' counts after reviewing the scanner output;
do not regenerate against a later HEAD to bless additions. Stack QA should check
buttons, settings rows, errors, accessible names and multiline text in en-XA,
including narrow widths and large type. This change itself renders no screens.
