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
When #4240 adds dictionaries, bind that module here; this helper chooses no locale.

Representative migrations: web `ScheduleSendMenu.test.tsx` and mobile
`memoryProposal.test.tsx`. Broader migration belongs in follow-up batches.
