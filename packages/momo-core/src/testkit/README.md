# Shared testkit (#4710)

New tests import fixtures from `@momo/core/testkit`. This entry point is for tests;
production code continues to import its feature modules directly. Core has no
React, DOM, Jest, storage, or filesystem dependencies. Mount ownership and flush
take renderer/act callbacks; each client supplies its own implementation.

Web tests use `@/testkit` (`mount` returns the host, `cleanupMounts` goes in
`afterEach`, `flush(rounds)` awaits real timer turns). Mobile tests use
`./testkit` (`mount(ui, client?)` wraps React Query and returns the rendered
result; pair it with `cleanupMounts`). Existing `renderWithQuery` stays available.
Fake-clock tests continue to advance their own clock with `settle`.

```ts
const copy = createCopy(SCHEDULED_COPY);
const button = control(host, 'button', copy('trigger.label')); // web
// control('button', copy('trigger.label'));                 // mobile
```

Bind the actual copy module, never a second catalog of expected sentences.
`createCopy` accepts string leaves by dotted key and throws for missing, inherited,
blank, or non-string values. Parameterized copy functions are called directly.
`blankCopy`, `copyStringCount`, and `missingKeys` are shared with mobile's existing
catalog checker; filesystem discovery remains in the mobile test adapter.
P0-6 (#4835 / ADR-0213 §4·§9) also binds the shared dictionary:

```ts
const catalog = await loadMessageCatalog('ko-KR'); // @momo/core/i18n
const copy = createMessageCopy({messageLocale: 'ko-KR', catalog}); // @momo/core/testkit
control('button', copy('settings.profile.languageRetry')); // mobile
copy('common.members.count', {count: 2}); // generated key/argument types
```

Supply the same locale/catalog as the mounted screen. Each binding owns its service;
no global locale is changed. Unlike the production service's safe fallback, this
test adapter throws on diagnostics (missing keys, invalid arguments, broken ICU)
so a query cannot accidentally match an unrelated fallback label. Existing
`createCopy` bindings stay available until their modules migrate in P1.

Translation/content review stays in mobile's `copyCatalog.test.ts`, which reads
the real ko/en JSON inputs without fallback and checks their nonempty key sets.
It retains discovery/blank checks of existing `*copy*.ts` modules. Query behavior
lives separately in `testkit/query.test.tsx` and uses keys/roles, without sentence
expectations. Mobile Jest transforms FormatJS ESM, static blocks and catalog
dynamic imports using test-only Babel settings; shipping Metro belongs to P0-4.

Representative migrations: web `ScheduleSendMenu.test.tsx` and mobile
`memoryProposal.test.tsx`. Broader migration belongs in follow-up batches.
