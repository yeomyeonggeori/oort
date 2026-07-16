# MOMO-447 macOS dogfood interaction shells handoff

## Product decision

macOS UX work does not wait for every engine contract. A surface must be useful and honest with local state first, then replace its adapter when the engine lands. It must never claim a remote write succeeded when only a local preview exists.

## Delivered surfaces

| Surface | Current behavior | Engine handoff seam |
|---|---|---|
| File attachment | File picker and timeline DnD create removable local URL draft chips | Upload local URLs through storage credential API; replace draft with durable attachment receipt |
| Profile | Demo/local mode edits a local display draft; real-server mode shows canonical member data read-only | Persist through member profile endpoint and refresh roster projection before enabling server editing |
| Approval | Existing real approval decisions, simplified inspector hierarchy and bulk reversible action | No new engine contract required |
| Search | `MomoWorkspaceSearchIndex` searches only client-loaded channels, active members, messages and explicit attachment metadata | Replace index provider with paged server FTS while retaining `MomoWorkspaceSearchDestination` |
| Direct message | Searchable picker calls existing `startDirectMessage` mutation | No new engine contract required |
| Plugin catalog | Five recommended plugins, local persistent selection/deselection preview, explicit connection-pending copy | Replace AppStorage binding with plugin registry install/grant/revoke and OAuth status projection |

## Ownership boundary

- `momo-main` owns the SwiftUI information architecture, interaction state, accessibility and localization.
- Fable/engine lanes own durable storage, token custody, server FTS, plugin registry/grants and connector execution.
- Engine integration should inject or replace adapters behind these surfaces rather than redesigning the user flow.

## Verification expectation

- macOS build/tests and `macos-ui` local gate.
- Real-window QA for `⌘F`, DM picker, profile edit, approval inspector, composer DnD and plugin catalog persistence.
- No provider credential, upload token or external OAuth token is stored by these SwiftUI surfaces.
