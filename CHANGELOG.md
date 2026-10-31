# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

How a later server/image tag is cut: [`docs/RELEASING.md`](docs/RELEASING.md).
Desktop Tauri next (`0.1.0-next.N`) is a different train —
[`docs/NEXT_CHANNEL.md`](docs/NEXT_CHANNEL.md).

## [Unreleased]

## [0.1.41] - 2026-10-31

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.41>. Tag target: `main=8bec2f53f`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres lists. Six database migrations (156 to 161; the schema goes from 155 to 161): 156 adds the tenant table `dm_agent_admission` (row-level security enabled and forced with the standard `ws_isolation` policy; a `SELECT, INSERT, UPDATE` grant to `momo_app` and a `SELECT` grant to `momo_notifier`, `momo_relay`, `momo_worker` and `momo_helper_read`, each when the role exists), a restrictive `SELECT` policy `dm_agent_read_boundary` on `message` that only narrows what a request carrying an agent identity reads in a DM, a `BEFORE INSERT` trigger `dm_agent_write_boundary` on `message` that refuses (SQLSTATE `42501`) a post by an agent that is not an active member of a DM it was admitted to, and an extension of `hosted_connection_channel_ids` (the old function stays under a new name and is called by the new one); 157 adds a nullable `usage_ledger.source` with a check (`measured` or `self_reported`), `model_pricing.source_url` and `verified_on`, eleven global public list prices effective 2026-10-01 (inserted only where not already present) and the tenant table `agent_subscription_fee` (row-level security enabled and forced; `SELECT, INSERT, UPDATE, DELETE` to `momo_app`); 158 adds a unique constraint `(workspace_id, id)` on `approval` and the team-expression tenant tables `expression_catalog`, `expression`, `expression_image`, `expression_draft`, `expression_draft_image` and `expression_report` (row-level security enabled and forced with `ws_isolation`, restrictive policies on the report table, `SELECT, INSERT, UPDATE, DELETE` to `momo_app`, triggers that keep identity columns immutable, and a column-level `SELECT (workspace_id, state, expires_at)` on `expression_draft` to `momo_notifier`); 159 adds `expression_assembly` and `expression_assembly_image` (same row-level security, restrictive agent-read policies and the same column-level grant on `expression_assembly`); 160 adds `self_media_token` (row-level security enabled and forced, a single-use trigger, the token stored only as a hash); 161 adds a nullable `origin_source_attachment_id` with a check to `expression` and `expression_draft` and widens `expression_draft_code_check` to fourteen codes, on the tables 158 creates. **`bootstrap_runtime_roles.sql` and `bootstrap_roles.sql` change**: both gain a lock on the privileges of `self_media_token` (`momo_app` `SELECT, UPDATE`; `momo_worker` `SELECT, INSERT, DELETE`; `momo_relay`, `momo_notifier` and `momo_platform_admin` nothing), and `momo_notifier` gains `SELECT (workspace_id, state, expires_at)` on `expression_draft` and `expression_assembly` and `SELECT` on `dm_agent_admission`; the post-migrate pass of the role file (the API pre-deploy) lands them, and a notifier of this release that starts before that pass logs a failed expression sweep until it has run. **156 holds a `SHARE ROW EXCLUSIVE` lock on `message` until it commits (it creates the trigger; nothing scans `message`), 157 holds `ACCESS EXCLUSIVE` on `usage_ledger` while its check scans the existing rows once, and 158 builds the unique index on `approval` without `CONCURRENTLY`, so writes to `approval` wait until it is built; on a database with large `message`, `usage_ledger` or `approval` tables apply them in a maintenance window.** No rollback SQL ships with 156 to 161, and the price rows 157 inserts stay once added; the previous release writes `usage_ledger`, `approval` and `message` with explicit column lists and sets neither `app.agent_member_id` nor an admission, so by reading its code it passes the new policy, trigger and checks. New environment variables, all optional and none needed for the upgrade: `OORT_SELF_MEDIA_ORIGIN` (unset; this instance's own public origin, set on the agent worker and on the same-server Hermes together — unset means no photo address is minted and the Hermes image guard keeps refusing every address), `OORT_HOSTED_MEDIA_STRICT` (the agent worker's attestation that the Hermes behind it runs strict media delivery; only the exact value `1` opens the hosted expression door, empty or unset keeps it shut, and the Railway template ships it empty), `RATE_LIMIT_SELF_MEDIA_PER_WORKSPACE` (30 rejected photo-address requests per workspace and window; `0` disables the limit, and a value that is not a number keeps the default), `MOMO_UNFURL_ENABLED` (existing, exact value `1` only, off by default — it now also gates `POST /expressions/import`), `OORT_EXPRESSION_ASSEMBLER` and `OORT_EXPRESSION_DECODER` (paths of two helper executables the image ships next to the server; unset uses those), and the file-store names `MOMO_DRIVE_ARCHIVE_BACKEND` (or `MOMO_DRIVE_BACKEND`), `MOMO_DRIVE_SA_KEY_PATH`, `MOMO_DRIVE_SHARED_DRIVE_ID` and `MOMO_DRIVE_LOCAL_DIR`, which the API already used and the agent worker now reads too, so it can read a picture the requester attached (unset, the worker cannot read attachments; in the self-host Compose files the worker gets the same values as the API, while a platform whose file store is a volume of the API service cannot share it with another service). The self-host and Railway templates' `hermes` service now sets `HERMES_MEDIA_DELIVERY_STRICT=1`, which its lock gate requires while the picture tool is exposed, and carries the new image-guard plugin files; an existing Hermes service is updated in the order given in `infra/railway/README.md` (strict flag first, then the gate and the start command in one change). The Centrifugo configuration gains an `expressions` namespace (`infra/centrifugo.json`; on Railway the `CENTRIFUGO_CHANNEL_NAMESPACES` service variable, as in `infra/railway/railway.json`): apply it first, then the server, then the apps — the server publishes the team-expression change frames on it.

### Added
- Phone: haptics are tied to a fixed list of events and have a setting — Settings › Notifications › Haptics offers Rich (the default), Basic and Off. Basic and Rich give a medium tap when a message's long-press menu opens, a tick when a reaction is added or removed, a light tap when a profile opens, one light tap at the pull-to-refresh threshold and a warning when a refresh fails; Rich adds a light tap for "jump to latest", ticks for the work and board filters and a medium tap for delete confirmations, and keeps a successful refresh silent (Basic taps for it). Nothing fires while the app is in the background, the answer to a pull you walked away from stays silent, and Off silences everything the app adds, while system controls follow the device settings (#4298, #4803, #4824).
- Phone: two helps for a flaky connection — pull down at the top of a conversation whose history is loaded to its start (until then, reaching the top loads older messages as before) to re-check the connection: it reconnects the live connection if needed and fetches the newest messages, also in an empty conversation, and a failure is announced like other pull-to-refresh failures; and Settings › About › "Copy connection log" copies the last 128 connection events — codes, times or ages, a fixed set of states and the network type, never server wording, error messages, tokens, addresses or message content — as pressing and holding the version line already did (#4783, #4805).
- Phone, web and desktop: a photo opens from the picture you tapped and closes back into it — it grows out of its place in the conversation, the controls appear once it has arrived, and going back (the back button, Escape or a drag down) lands on the picture of the page you are on, or slides out below the window when that picture is not fully in view; a zoomed picture first fits, then closes; the backdrop only fades, and with Reduce Motion the viewer opens and closes at once. On the phone the double-tap zoom now counts two taps within 300 ms instead of 400 (#4775, #4807).
- Server: an agent can be asked to change a name or a photo in four ways — your name (`member.display_name.set`, new), your photo (`member.avatar.set`, which now also takes an image the agent generated or fetched, not only one you attached in the conversation), its name (`agent.rename`) and its photo (`agent.profile.update` with `avatar`); only the person who asked can decide a card about their own name or photo — not an admin, not the agent's owner — a rename leaves the handle and past mentions alone, the team AI now takes all four (its own photo from an image, no longer presets only), and an external agent's photo can come from a picture the requester sent in the same conversation (ADR-0186 addendum v7, #4791, #4808).
- Phone, web and desktop: the approval cards for these four requests show the name before and after and, for a photo, the current picture next to the new one, telling apart no photo, loading and failed; the line that says who may decide reads "the person who asked"; and after you approve a profile card the app re-reads the member list so your new name and picture show at once on that device, the others getting them with the usual 30-second refresh (ADR-0186 addendum v7, #4791, #4808).
- Phone: a full-screen theme picker — the theme style row in Settings › Theme opens it, with filters by mode and two-column previews; a choice applies at once, a theme with only one mode says so, and undo returns to the theme and mode you came in with (#4194, #4813).
- Web and desktop: a language setting — Settings › Profile › Language offers "Follow device", 한국어 and English, kept on this device only; English carries a "beta" and partial-support note, because the wording of existing screens is not in the dictionary yet; new dependency `@formatjs/intl` (MIT), attributed in `packages/momo-core/NOTICE` (ADR-0213, #4830, #4831, #4832, #4838, #4850, #4860).
- Phone: the same language setting under Settings › Profile › Language — a choice changes the wording that is in the dictionary at once and the iOS permission texts come in Korean and English; at launch the app tests the engine's `Intl` and fills only what is missing with FormatJS polyfills, closing onto an English safe-text screen if that test fails (ADR-0213, #4833, #4867).
- Server: an agent can join a person-to-person DM with everyone's consent — mentioning it raises the usual approval card for each other person in the DM, decided only by the person it names, and the agent is seated only when all have approved (one refusal or expiry seats nothing); it then reads only what is posted after it was seated plus the message that called it, and any person in the DM can remove it at once, which also ends its running work (ADR-0217, ADR-0162 addendum 6, #4792, #4809; migration 156).
- Phone and web: DMs with agents — the mention list in a DM offers the agents you may call, a line before sending says the agent joins once everyone else agrees, and the approval card shows what it will read and that anyone can remove it; joining and removal show as system lines, "remove agent" is in the member menu, and a DM with an agent is named by its members and headcount (ADR-0217, #4792, #4809).
- Server: what agents cost, in the open — usage rows carry a source (measured, or self-reported by the agent), and `GET usage/agents` answers per agent for this month so far (UTC) with cost, tokens and runs: members read the shared agents and their own personal ones, other people's personal agents come back as a count only, admins read all, and a run without a price is counted in `unpricedRuns` instead of the amount; a human owner or admin can set a flat monthly fee for a shared agent, never added to costs or totals (ADR-0147 addendum, #4781, #4816; migration 157).
- Phone, web and desktop: agent lists and profiles show this month's cost, tokens and tasks with a source tag — a hidden personal agent is only counted, and an estimate or an unpriced run reads as "at least"; the web AI-agents table gets a cost column, and admins get a monthly report (UTC) in Settings › Usage on web and desktop and in Settings › Monthly report on the phone, with a shared agent's flat fee to set or clear (ADR-0147 addendum, #4781, #4828, #4856).
- Phone: reactions and status take every standard Unicode emoji — the quick-reaction row's `+` and the status emoji open one searchable picker (Korean names, search in Korean, English or `:code:`, frequently used, skin tones), and emoji newer than the device's iOS version are hidden; new data source `emojibase-data` 18.0.0 (MIT, with Unicode CLDR annotations), attributed in `NOTICE` (#4322, #4852).
- Server: a store for the team's own expressions — custom emoji, stickers and team GIFs: an upload or an attachment is checked, re-encoded in isolation into three sizes and activated after a second check; PNG, JPEG, still WebP and GIF are accepted, video is refused, and a workspace holds up to 1,000; clients follow changes on a new `expressions` realtime namespace (`infra/centrifugo.json`; on Railway `infra/railway/railway.json`); new permissive dependencies (`gif`, `multer` and `rlimit` among them) are attributed in `NOTICE` (ADR-0218 D1–D3 and D6, #4676, #4864; migration 158 adds six tenant tables with row-level security enabled and forced).
- Web and desktop: team expressions — "Our team" in the emoji picker lists custom emoji, stickers and team GIFs; upload a file or import from a source link, add a name and tags and say whose face it shows, and it is registered only after a permission check; the creator or an admin deletes and anyone reports; `:name:` autocompletes, and GIFs play four times then rest on a still (always still under Reduce Motion); an agent's `expression.create` card shows its candidates and registers the one you choose (ADR-0218 appendix C, #4677, #4857).
- Phone: team expressions — the "Our team" slot of the emoji picker is filled in the reaction sheet, and a new composer picker opens the same list, searched by name, tag or initial consonants; a large expression is previewed and sent with a second tap, and choosing again or closing cancels it and keeps your draft; GIFs play four times then rest on a still, and stay still under Reduce Motion (ADR-0218 appendix C, #4678, #4858).
- Server: expressions can be registered from links — `POST /expressions/import` takes a public HTTPS source link and makes a draft (a failed fetch leaves a reason code and leads on to uploading it yourself), never while `MOMO_UNFURL_ENABLED` is off; the agent action `expression.create` proposes one to four candidates from a conversation attachment, a link or a generation, the approval card shows the pictures that would be saved, one choice is registered and the rest are cleared, and a face's subject alone can approve (ADR-0218 D5 and appendix C, ADR-0186 addendum v8, #4829, #4876; no migration).
- Server: animated expressions can be assembled from one photo and a motion preset — `assemble` builds a GIF candidate in an isolated child process with memory and time limits, honouring EXIF orientation; results are kept for one hour in new tables `expression_assembly` and `expression_assembly_image`, at most 12 candidates per agent; the Agent Port MCP tool `oort_expression_assemble` (no new scope) takes the requester's attachment from the same conversation or base64 and returns closed failure codes; the Docker image and `local_alpha_runner.sh` install the assembler (ADR-0218 §7 G3, #4820, #4902; migration 159).
- Server: a short-lived address of the server's own for one photo, so that the same-server Hermes's picture tool can be given the requester's photo — a random single-use token (only its hash is stored) tied to the run, requester and attachment, valid only while the run is in progress, behind a public `GET /v1/self-media/{workspace}/{token}` that answers every refusal with the same 404 (`RATE_LIMIT_SELF_MEDIA_PER_WORKSPACE` sets its refusal budget, optional). Off by default: no address is minted until `OORT_SELF_MEDIA_ORIGIN` is set on the agent worker and on Hermes (ADR-0218 G4 and G8, ADR-0203 I2 and I4, #4820, #4907; migration 160).
- Server: the hosted door — when the same-server Hermes answers a turn that carries the requester's photo, the server turns the one picture in its reply into an expression proposal card, or into a closed failure card with one of six fixed codes, so nothing the model wrote reaches the card; `expression.create` also takes an assembled result. Off by default: the door opens only when an operator sets `OORT_HOSTED_MEDIA_STRICT` on the agent worker and `HERMES_MEDIA_DELIVERY_STRICT` on Hermes — both are needed — and on an existing Railway project Hermes is updated first, the worker after (ADR-0218 §7 G3.7 (b) and G3.8, #4820, #4909; migration 161 adds a pointer column for the generating photo to two tables and widens a draft's code check).
- Server: the same-server Hermes can search the web with the Codex subscription — search only: page extraction stays refused, and turning a connector on switches the whole web toolset off; it works with a Codex model, a query can contain conversation text and goes to OpenAI's search with no promise to mask or not to keep it, and on a team instance `HERMES_CONFIG_B64`, `HERMES_LOCKGATE_B64` and the start command's checksums change together (ADR-0203 addendum W1–W4, #4794, #4849).
- Server: the same-server Hermes can make pictures with the Codex subscription (`image_generate`, provider `openai-codex` only) — other picture providers, code execution and page extraction stay refused, a connector turns picture generation off too, and the tool is offered only while a Codex sign-in exists; prompts and reference pictures go to OpenAI with no promise to mask or not to keep them; a team instance changes `HERMES_CONFIG_B64`, `HERMES_LOCKGATE_B64`, the new `HERMES_IMAGE_GUARD_B64` and `HERMES_IMAGE_GUARD_MANIFEST_B64` and the start command's checksums together (ADR-0203 addendum I1–I4, ADR-0218 §7 addendum, #4820, #4868).
- Web and desktop: "Make with AI" in the team expressions panel — the "+" becomes a menu with Import (the old upload) and Make with AI, a form with a photo, one of four motions (or none) with a preview, an agent and a note; Send opens the DM and posts the request as one message with the photo; approval and failure cards gain an "original photo" row, an "n pictures" count and a line for each of six failure codes; with the same-server Hermes a picture comes back as a proposal or failure card only when the operator has turned the hosted door on (off by default, #4909) (ADR-0218 §7 G1, G3.3, G3.8, G5 and G6, #4820, #4885, #4893).
- Web and desktop: a decision stage — the "approval needed" chip, an "open to decide" card and a thread's summary line open a blurred full-window stage with floating glass Reject and Approve buttons and a thumbnail strip, "n of N" and previous and next; after each decision it moves on to the next undecided card, then says everything is decided and returns to where it opened; there is no swipe to approve, and the decision leaves a receipt on the original card (#4826, #4847, #4863). Not shown until the server part ships (#4763, #4764).
- Phone: the same decision stage — an approval chip, the card header, "open to decide" or the VoiceOver action opens a stage that grows out of the place you tapped, with a blurred backdrop and glass Reject and Approve buttons; you decide with buttons only (no swipe to approve), a response without a status never moves on by guess, and leaving the workspace or channel drops the stage so a late answer cannot cross into another conversation (#4827, #4859). Not shown until the server part ships (#4763, #4764).
- Server: the person who asked gets one notification when their request ends in a refusal, an expiry or the action being done — not the person who decided it, nor anyone who has just been reading the conversation; it carries no Approve button and opens the card, and a proposal notification is no longer sent for an approval that has already closed (ADR-0186 addendum v6, ADR-0204 addendum 6, #3982, #4815).

### Changed
- Phone, web and desktop: who is typing is easier to see — the typing line under the composer shows the name in bold, the word "typing" and the three moving dots the agent "answering" line already uses (one name, "A, B" for two, "A and N others" for three or more); with Reduce Motion the dots stand still, and the spoken sentence and the line's reserved height are unchanged, so the composer does not jump (#4797, #4802).
- Phone, web and desktop: a channel's notification setting shows its state instead of an action — "Notifications on" with a bell, "Notifications off" with a crossed-out bell — in the conversation info page, the ⋮ sheet and the channel row sheet on the phone and in the header ⋮ and the sidebar row menu on web and desktop; it flips the moment you tap, a failed change goes back for that channel only and says so, a second tap while one is being saved is ignored, and the "turning on…/turning off…" in-between wording is gone (#4797, #4802).
- Phone: the conversation header band is gone — the list scrolls up under three floating glass buttons (back, the name-and-status pill and ⋮, each its own glass, opaque with Reduce Transparency) with a soft fade at the top so the status bar stays readable, and threads use the same header; "jump to latest" is a round 44-point glass button with a count of new messages (99+), and the floating date chip is a glass pill with larger type (#4789, #4804).
- Phone, web and desktop: the composer grows to four lines on the phone (conversation, thread and work conversation) and five on web and desktop (conversation and thread) before it scrolls inside — it was five and six — and on the phone the 44-point tool row is now counted in the height limit, so four lines of text stay visible above it (#4790, #4467, #4806).
- Phone: the input pill fills the width — its side margin goes from about 40 to 8 points, and the offline and DM hints, the agent notice, the quote and the attachment tray line up on the same 8-point edge (#4790, #4203, #4806).
- Server: in the self-host Compose files the agent worker now gets the same file-store settings as the API (`MOMO_DRIVE_ARCHIVE_BACKEND`, `MOMO_DRIVE_SA_KEY_PATH`, `MOMO_DRIVE_SHARED_DRIVE_ID` and `MOMO_DRIVE_LOCAL_DIR`, all optional), mounts a local file store read-only and starts only after the API is healthy, so that it can read a picture for a profile proposal; it never writes to the store (#4791, #4808).
- Web and desktop: one request is one bundle card — it reads eight states in the same place (head sentence, up to two value chips, Approve and Reject); the thread's summary line carries a status chip and shows Approve and Reject only when one proposal is waiting, the server marks it inline, you are the one to decide and the whole question fits on the line (otherwise "Open to decide"); the request thread and the agent DM get a thinking line; and desktop notifications use the agent's name as the title and the question as the body and open the thread at the card (`docs/design-system/agent-request-loop.md` §8.3, #4760, #4761, #4814, #4853). Not shown until the server part ships (#4763, #4764).
- Phone: the same bundle card in the same words — eight states, up to two values, details and a one-time value, falling back to the existing approval card when the server sends no bundle; Approve and Reject are a 44-point pair that reuses the existing decision handling; a status chip keeps its size as the state changes and opens the thread card, a thinking line holds its height in request threads and agent DMs, and the lock-screen result notification reads one line from `receipt.line` (#4760, #4762, #4814, #4848). Not shown until the server part ships (#4763, #4764).
- Server: an approval card ends in the card itself — approve, refuse, expiry and a person's cancel write one shared close (status and code, who and when, the result and a Korean body) with a `message.edited` frame, so other viewers see it change without a refresh, and separate result lines for executed, refused and expired cards are no longer written; on phone, web and desktop the card summary shows the code's wording and an executed result's sentence (ADR-0186 addendum v6, ADR-0204 addendum 6, #3982, #4815).
- Server: `usage/summary` follows the same visibility rule as the new per-agent read — everyone but admins gets no `budget` key and `scope=visible`, with totals, buckets and the by-model and by-agent splits recomputed over what they may see; admins keep today's JSON and recorded amounts (ADR-0147 addendum, #4781, #4816).

### Fixed
- Phone: coming back to the app no longer so often ends in "disconnected" — the sign-in token is refreshed first when two minutes or less of it are left, so the live connection no longer starts on an expired one; unlocking the phone reconnects at once and starts the retry delay over; and the conversation says "connecting" through any gap and "disconnected" only after 10 seconds (it was 4), a retry no longer pushing that deadline back (#4783, #4805).
- Phone: a long text pasted into the composer, or a draft restored into it, no longer stays in a window of about two lines — the field takes its height from the text it holds, grows to its limit and scrolls inside only beyond it; a long room name no longer wraps the empty field's placeholder onto a second line, and at the larger text sizes (AX1 to AX5) neither the folded nor the unfolded field clips its placeholder or first line (#4615, #4202, #4516, #4790, #4806).
- Web and desktop: the last line in the composer is no longer clipped by the thickness of the field's border as it grows (#4790, #4806).
- Phone: the connection band starts below the conversation header instead of over the room name, and the haptics note in Settings › Notifications sits outside the notifications card with the other notes (#4839, #4845).
- Phone: a photo approval stays locked until its preview has really been drawn — when the preview cannot be fetched or shown, a failure line with a "Reload" button appears and Approve stays off, on screen and in the VoiceOver rotor, while Reject keeps working; a changed card or photo locks it again (#4846, #4851).
- Phone: a live connection that stayed down for long with the app in front now recovers — coming back online reconnects at once even on the same connection type, the retry delay is capped at 5 seconds while the app is in front and online (20 seconds otherwise, as before), a connection that ended on a token problem retries up to twice with a fresh token, and tapping the "disconnected" band reconnects now (#4895, #4899).
- Phone: text in a bubble that holds a list (`- ` or `1. `) no longer folds to zero width or runs out of the bubble; the long-text clipping in a DM bubble that was reported could not be reproduced, so its issue stays open (#4894, #4901).
- Server: name changes are decided in the app — `member.display_name.set`, `agent.rename` and `agent.profile.update` with a name carry no lock-screen Approve and Reject buttons, and you see the old and the new name in the app before deciding; the notification's decision data says only whether a name is present, never the name (ADR-0186 addendum v7, #4810, #4837).
- Server: approving a stored action that a person asked a hosted agent for now checks the agent's connection from its row state (active, proven, not revoked), and without one the approval stays pending and shows why it was refused; such a card is also tied to the connection it was raised on, so after a reconnect it can only be refused or expire (409 `action_args_invalid`, nothing spent), and the "write in this channel" card records its connection too; cards still waiting when the server is upgraded cannot be approved — refuse and ask again, or let them expire (ADR-0186, #4772, #4818, #4821, #4844, #4896).
- Security: the phone app's lockfile moves `node-forge` to 1.4.2 and `joi` to 17.13.9, closing 12 of the 19 npm advisories published on 10-31; the other seven, in build and lint tools that are not in a shipped bundle and whose fixes need a new major version, are held as time-limited exceptions in `osv-scanner.toml` until 2026-12-31; no major version changes (#4903, #4904).

## [0.1.40] - 2026-10-29

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.40>. Tag target: `main=1a8225215`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres lists. Four database migrations (152 to 155; the schema goes from 151 to 155): 152 adds the value `dev` to `token_kind`, the developer-token columns, named checks, a trigger that lets only human members hold such a token and a partial unique index on `token`, plus a nullable `message.sent_via` column; 153 adds the tenant table `dev_login_authorization` (row-level security enabled and forced with the standard `ws_isolation` policy, and a `SELECT, INSERT, UPDATE` grant to `momo_app` when that role exists); 154 widens three hosted-agent scope checks by `workspace:initiate` and changes no row; 155 adds two partial indexes (`agent_run_initiative_rate_idx` and `approval_initiative_idx`, for the rate and cool-down lookups of unasked proposals) and the tenant table `agent_initiative_refusal` (row-level security enabled and forced with the standard `ws_isolation` policy, a `SELECT, INSERT, UPDATE` grant to `momo_app` when that role exists), which holds the state of the one-audit-row-an-hour refusal log. `bootstrap_runtime_roles.sql` is unchanged. **152 holds `ACCESS EXCLUSIVE` locks on `token` and `message` until it commits and its check on `message` scans the existing rows once, so on a database with a large `message` table apply it in a maintenance window. 155 builds its two indexes without `CONCURRENTLY`, so writes to `agent_run` and `approval` wait until they are built; on a database with large tables apply it in a maintenance window too.** No rollback SQL ships with 152 to 155, and the enum value `dev` stays in `token_kind` once added. New environment variables, all optional and none needed for the upgrade: `MOMO_DEV_ACCESS_RATE_LIMIT_WINDOW_SECONDS` (60), `MOMO_DEV_ACCESS_RATE_LIMIT_PER_TOKEN` (240), `MOMO_DEV_ACCESS_RATE_LIMIT_PER_MEMBER` (480) and `MOMO_DEV_ACCESS_RATE_LIMIT_WRITE_PER_TOKEN` (30) are the request budgets of developer tokens per window, and **there is no off switch: 0, a negative number, a blank value or anything that is not a number keeps the default**; `MOMO_DEV_LOGIN_OAUTH_ENABLED` is an opt-in switch for the browser approval of `oort login` (only the exact value `true` opens it), and when it is on, `MOMO_DEV_LOGIN_OAUTH_CONSENT_URL` (one absolute https URL) and the existing `MOMO_AGENT_PORT_OAUTH_ISSUER` (one exact https origin) must be set or the server refuses to start; `MOMO_AGENT_INITIATIVE_PER_HOUR` (6, 1 to 60), `MOMO_AGENT_INITIATIVE_PER_DAY` (20, 1 to 240) and `MOMO_AGENT_INITIATIVE_TTL_HOURS` (24, 1 to 168) are the rate and the lifetime of cards an agent raises unasked, and a value out of range is clamped while one that is not a number falls back to the default, each with a warning. The Centrifugo configuration gains an `online` namespace (`infra/centrifugo.json`; on Railway the `CENTRIFUGO_CHANNEL_NAMESPACES` service variable, as in `infra/railway/railway.json`): apply it first, then the server, then the apps — a server that starts before it only leaves the presence dots out and never reports people as offline.

### Added
- Server: named developer tokens — a card token (30 days by default, 90 at most, shown once) or the session behind a command-line sign-in — act as the person only on a closed list of routes and never on approvals, default to "read only", can be limited to chosen channels, need the current password again to create, and end when the password changes or the member is suspended, removed or leaves; only workspace admins can create one for now. Messages sent this way carry a `sentVia` field that no screen shows yet (ADR-0216, #4660, #4721; migration 152).
- Server: a separate MCP endpoint for people, `POST /v1/mcp/me`, that takes developer tokens only and offers five tools — `oort_me_whoami`, `oort_me_channels`, `oort_me_read` (threads included), `oort_me_post` and `oort_me_inbox`; it cannot restructure, decide approvals, edit, delete or search, and a send spends the same budgets as the REST route (ADR-0216, #4661, #4731).
- Server and web: `oort login` can sign in through the browser — a consent screen shows the server host and device name, asks for the current password again and approves "read only" by default, then the terminal client receives its session over a loopback redirect with PKCE. Off by default (`MOMO_DEV_LOGIN_OAUTH_ENABLED`) (ADR-0216, #4700, #4737; migration 153).
- CLI: the `oort` terminal client (crate `oort-cli`) — `login` (browser approval or a card token on standard input), `logout`, `whoami`, `channels`, `read`, `post`, `inbox`, `token` and `mcp` (a stdio bridge to `/v1/mcp/me`), each with `--json`; the sign-in is kept in the macOS keychain or, elsewhere, a 0600 file, and `OORT_TOKEN` overrides it. It is not in a release artifact yet; new dependency `clap` (MIT OR Apache-2.0) (ADR-0216, #4662, #4750).
- Phone, web and desktop: Settings › Apps and connections › Command line and AI tools — create a connection (name, tool, "read only" or "read and send", chosen channels, expiry, current password), see its value once, list your connections and revoke them; admins can switch to everyone's list, read only. The phone lists and revokes only (ADR-0216, #4663, #4739).
- Server: the member roster carries `online` on active human rows, read live from Centrifugo presence — nothing is stored, and the field is left out (never "offline") when the read fails; clients join a new `online` presence channel per workspace to be counted, which only active human members of that workspace may do (ADR-0160 addendum 1, #4692, #4722).
- Phone, web and desktop: people get a presence dot — filled green when connected, an empty grey ring when not, nothing when unknown, with do-not-disturb and away still taking precedence — in DM rows, the conversation header and the new-conversation pickers (on web and desktop also in profiles and the member list); it refreshes every 30 seconds while visible (#4692, #4722).
- Server: the agent liveness read for members and the hosted-agent connection list for admins carry a `cadence` — `routine` (typical minutes, the next expected check, whether it is late), `realtime` or `unknown` — derived from the agent's recent Agent Port calls, so a screen can say a request will be picked up at the next check (usually within N minutes) instead of guessing; no new table, column or migration (ADR-0200 addendum 6, #4621, #4697).
- Server: when a person approves or rejects an agent's proposal, or cancels a stopped run, the proposing hosted agent gets exactly one `agent_run` reference in its inbox, so it wakes with the outcome; expiry is not written, a repeated call reports it (ADR-0186 addendum v5, #4702, #4732).
- Server: an agent can propose pinning or unpinning a message (`message.pin`, `message.unpin`); the approval card shows the channel, author, time, the first 120 characters, the length and the pin count, and the pin is made as the approver and audited like a manual one, without the message text (ADR-0186 addendum v5, #4703, #4734).
- Server: a hosted agent granted the new `workspace:initiate` scope (in no default request and in no existing connection) can raise an approval card nobody asked for in its owner's one-to-one DM — create a private channel, add a member, pin or unpin — through `oort_action_initiate`; the card says it was not asked for, and nothing runs until a person approves in the app, with the approver's own rights (ADR-0186 addendum v5, #4704, #4745; migration 154).
- Server: limits on unasked proposals — at most two waiting per agent (three counting the ones a person asked for), six an hour and twenty a day per agent (`MOMO_AGENT_INITIATIVE_PER_HOUR`, default 6, 1–60; `MOMO_AGENT_INITIATIVE_PER_DAY`, 20, 1–240), the same proposal not again within 24 hours of a refusal or expiry, and a card that waits a day (`MOMO_AGENT_INITIATIVE_TTL_HOURS`, 24, 1–168; out-of-range values are clamped with a warning). Admins can turn the whole door off with the workspace setting `agent_initiative` (absent means on), which an agent cannot change. When a person approves, the server proves the card again — the switch is on, the agent's connection is still active and not revoked and still holds the scope, the decider is the agent's current owner — and runs nothing otherwise (409, the approval stays pending); refusing always works. Each refusal reason leaves at most one audit row an hour, with no arguments or names (ADR-0186 addendum v5, #4704, #4771).
- Phone, web and desktop: unasked proposals show on screen — the connection consent screen (web and desktop) lists the new "propose first" permission, never in the default request; a card raised unasked carries a tag on its title and labels the agent's reason as the agent's own text; pin and unpin cards show the server-read details with a "view full message" link; and Settings › Workspace gets an `agent_initiative` switch for admins on web and desktop, drawn only on a server that knows the key (ADR-0186 addendum v5, #4705, #4754).
- Phone: push notifications show the sender's round photo with the small oort icon (iOS Communication Notifications), falling back to an initials face and then to the plain notification. Settings › Notifications gets two switches, message preview and sender display, both on by default and kept on the phone; turning sender display off or signing out clears the cached faces (adapted in part from Buzz's push kit, Apache-2.0, attribution in `NOTICE`; ADR-0204 addendum 5, #4316, #4715).
- Phone: pinch and double-tap zoom in the photo viewer (1–3×), with paging and swipe-to-close paused while zoomed (#4769, #4777).
- Web and desktop: zoom in the image preview with a trackpad pinch, ⌘-scroll, a double click or ⌘+/⌘−/⌘0, and drag to pan while zoomed (#4770, #4776).

### Changed
- Web and desktop: agent work in a conversation reads differently — a one-line rail above the composer shows who is working and the latest step, a chip in the header of the message that called an agent shows how far the request got (received, picked up, working, waiting for approval, answered, not picked up yet, timed out, failed), and the status sentence under every message is gone. Only exceptions (not picked up, wake signal not delivered, failed, timed out) keep a line, with their actions (#4619, #4648).
- Server: the final answer to a request made inside a thread now lands in that thread, with the quote kept (it used to leave the thread), on every answer path — external agents, the REST callback, managed workers and the team AI — and the instructions agents read (tool descriptions, conversation preamble, team AI prompt, hosted routine template) say what to write in a conversation (ADR-0148 addendum, ADR-0200 addendum 5, #4622, #4680).
- Phone: every bottom sheet closes by dragging it down from anywhere — header, handle or body — following the finger and sliding out at the speed you let go (at once with Reduce Motion); a sheet with unsaved edits asks before discarding, whichever way you close it (#4612, #4688).
- Phone: the close X is at the top right on pages as on sheets (the settings page had it on the left), and the "leave your first reply" hint under a thread with no replies is gone (#4691, #4690, #4713).
- Phone: in a DM or channel the name-and-status pill in the header opens an info page and ⋮ opens the shared action sheet instead of the system menu; the author line of a message is no longer a button — a profile opens from the face or an @mention, which now works — and the profile sheet is rebuilt on the shared sheet kit (#4319, #4666, #4720).
- Phone: "jump to latest" lands on the newest message at once instead of gliding for about a third of a second, and a long jump is no longer pushed back on the way (#4689, #4727).
- Web and desktop: the image preview drops its white title strip and uses the blurred app as a full-window stage; the controls are round glass icon buttons over the picture, the sender and time sit in a chip at the top left clear of the macOS window buttons, several pictures get a thumbnail strip with an "n of N" caption, and a click on the empty stage now closes it (#4751, #4756).
- Phone: the photo viewer is rebuilt in the style of messaging apps — a black stage in both themes, a round glass back button with the sender and time at the top left, a thumbnail strip with an "n of N" caption when a message has several photos, round glass Save and Share buttons at the bottom, and one tap hides or shows the controls (#4297, #4768).
- Server: sign-in, claim and password change now create their session under the same membership lock and in the same transaction as their checks, as join already does; in the rare overlap with a membership change, sign-in and join can answer 503 with `Retry-After: 1`, and a claim by a member who is no longer active answers the documented 404 `claim token is invalid` (ADR-0215 addendum 2, ADR-0128, #4636, #4695).
- CI: PR CI runs the TypeScript tests as three jobs (core, web, phone), runs the policy regression fixtures in their own lane and moves the 164-second loopback timing test to a nightly workflow; the required checks and the `PR CI gate` name are unchanged, and `REVIEW.md` holds the review standard with a risk-tier path table (#4696, #4724).
- CI: the PR lane classifier reads the changed-path list from a file, and an error in it now fails the job instead of counting as "no match" (#4728, #4736).
- CI: the nightly full Postgres run, red four nights in a row, now starts each target on a fresh database, classifies failures and moves what it cannot fix into a named quarantine list (owner issue and deadline) that the nightly summary always shows; an expired entry turns the nightly red (#4707, #4741).
- Tests: fictional people replace real names in the stress roster and the harness fixtures, with a check that keeps real names out (#4632, #4683); flaky tests are made deterministic and web and phone get a narrow retry registry — flaky-issue tests only, one retry, two weeks (#4708, #4738); source-scanning tests of the progress and lock grammar move to lint rules (#4711, #4742); the phone gets a shared test kit, and 33 issue-numbered test files are merged into 20 by target with the same assertions (#4710, #4743, #4709, #4744).

### Fixed
- Phone: tapping the conversation while you type now lowers the keyboard and folds the composer into its resting pill (the text is kept; tap the pill to unfold it), also over links, avatars, author lines, reply markers, reaction chips and thread summaries, which used to keep the tap to themselves; an auto-correction that lands as the keyboard drops no longer reopens the composer (#4614, #4693).
- Phone: the first message you send on a new day no longer makes the conversation bounce twice — the date divider now appears with the sent message instead of squeezing in when the server confirms it (#4749, #4757).

### Docs
- Command line and AI tool access decisions: human developer tokens, a separate human MCP endpoint and the `oort` CLI, with a closed route table and browser approval first (ADR-0216, #4617, #4699).
- First proposals and message pinning for agents (ADR-0186 addendum v5, #4659, #4701).
- Design system: the agent request loop — one card per request that changes in place, the request's thread as its home, a thinking line, push sentences and an Approvals tab in the inbox; the implementation follows (#4755, #4759).

## [0.1.39] - 2026-10-27

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.39>. Tag target: `main=c06693e8d`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres lists. Two database migrations (150 and 151; the schema goes from 149 to 151): 150 adds `attachment.reserved` and `attachment.unreserved_at`, a trigger that mirrors scheduled-message reservations onto them, a partial index and column-level `SELECT` grants for `momo_notifier`; 151 removes the file name from older `attachment.upload_started` audit rows. **151 rewrites audit rows and cannot be undone** — the logical dump taken before the deploy is the only way back. `bootstrap_runtime_roles.sql` changed (one column grant for `momo_notifier` on `attachment`, skipped until migration 150 has added the columns; the pre-deploy applies it twice around the migrations). The v0.1.38 server names every `attachment` column it uses and no server code reads an audit row's file name, so rolling the image back to v0.1.38 needs no SQL. New environment variables, all optional with defaults and no setting needed: `MOMO_ATTACHMENT_RECLAIM` (off; the cleanup of unattached uploads deletes only when it is exactly `1`, otherwise each tick writes one dry-run line), `MOMO_ATTACHMENT_RECLAIM_INTERVAL_MS` (600000, at least 10000), `MOMO_ATTACHMENT_RECLAIM_BATCH` (50, 1 to 500), `MOMO_ATTACHMENT_RECLAIM_DATABASE_URL` (only for a notifier with a Google Drive; falls back to `MOMO_AVATAR_RECLAIM_DATABASE_URL`, then `MOMO_HUDDLE_SWEEP_DATABASE_URL`) and `RATE_LIMIT_PASSWORD_GUESS_PER_ACCOUNT` (5 per window; 0 or a non-number means the default, there is no off switch). This release makes joining with an email that already has an account need that account's own password (with a per-account attempt budget), sets the 10-character password minimum, stops serving files of deleted messages, keeps file names out of upload audit rows, adds an operator-only cleanup of unattached uploads (off by default) and one diagnostic audit row per Agent Port call.

### Added
- Phone: the home avatar opens a Buzz-style Settings page — round X, a large avatar, a status pill, grouped cards and a status sheet — in place of the profile sheet (#4457, #4623).
- Server: each Agent Port call leaves one diagnostic audit row (method, tool, outcome and counts; no arguments, bodies or tokens; capped per credential per hour) so the server can show where a hosted agent stops (ADR-0200 addendum 4, #4618, #4634).
- Desktop: a download button at the top right of the title bar — progress ring, a dot for new files, a panel with this session's and recent downloads, Show in Finder, Open and Download again; files go to the Downloads folder only, are never overwritten, executable types are not opened, and saved files carry the quarantine flag (ADR-0133 addendum, #4587, #4638).

### Changed
- Desktop: a drag band at the top of the window (the content starts below it); the conversation header uses a soft shadow instead of a border; header buttons get faint outlines and design-system tooltips; the area outside the pane follows the sidebar colour when the theme changes; a slot at the top right of the title bar for downloads (#4591, #4624).
- Phone: every bottom sheet closes with a round X and uses the shared inner parts; the confirm ✓ shows progress while it works (#4458, #4629).
- Server: a new password needs at least 10 characters and at most 72 bytes, and one with a NUL character is refused; the web claim screen says which rule failed (ADR-0215, #4593, #4626).
- Server: joining with an email that already has an account works only with that account's own password, under a per-account attempt budget; a pending or deleted account cannot join through a general invite (ADR-0215 addendum 1, ADR-0128, #4625, #4630).
- Server: a file that a deleted message carried is read by nobody and listed nowhere; upload audit rows no longer carry the file name, and the upgrade removes it from older rows; an operator-only cleanup of unattached uploads, off by default (ADR-0151 addendum 2, #4443, #4589; migrations 150 and 151).

### Fixed
- Phone: the conversation no longer moves up and down during the first minute while an agent request is waiting — the ticking seconds keep a fixed width, so the activity line no longer flips between one and two lines (#4613, #4628).

### Docs
- Login and recovery v2 decisions: a device link code you can type or paste, changing your password while signed in, an admin reset that asks for the admin's own password, and a 10-character minimum (ADR-0215, #4574, #4592, #4610).

## [0.1.38] - 2026-10-26

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.38>. Tag target: `main=a12c025df`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres lists. One database migration (149; the schema goes from 148 to 149): a data patch on the seven official rows of `plugin_registry` (display fields and the team drive's publisher name) with no table, column, policy or role change; `bootstrap_runtime_roles.sql` is unchanged. **An older server refuses the patched manifests**, so rolling the image back below v0.1.38 needs the 149 rollback SQL first (it is at the bottom of `server/Migrations/149_official_catalog_display_fields.sql`); otherwise the seven official apps vanish from the older server's catalogue and installs and grants answer 409. New environment variables, all optional with defaults and no setting needed: `RATE_LIMIT_MESSAGE_SEND_PER_MEMBER` (120), `RATE_LIMIT_MESSAGE_SEND_PER_AGENT` (600), `RATE_LIMIT_SCHEDULED_WRITE_PER_MEMBER` (60) and `RATE_LIMIT_UPLOAD_START_PER_MEMBER` (60) requests per window, where 0 removes a budget, and `MOMO_SELF_HOST_PLATFORM` (the platform stamp `scripts/self_host_env.sh` writes; Railway is detected through its own `RAILWAY_ENVIRONMENT_ID`). This release adds per-member write rate limits, the official-app catalogue (logos, categories, starter prompts, "my app runtimes"), a Light default appearance and a shared bottom-sheet kit on the phone, an in-app banner for messages in other conversations, and attachment reads limited to the uploader until a message carries the file.

### Added
- Phone: shared sheet kit — every reworked bottom sheet closes with a round X (✓ on the left to confirm), grouped cards, input pills and section labels; rules for page vs drawer vs bottom sheet in `docs/design-system/phone-sheets.md` (#4318, #4556).
- Phone: a sent message rises from under the composer (Buzz curve, 300 ms) with no "Sending" flash and no height jump; a small clock appears only when sending takes longer than 1.5 s (#4455, #4562).
- Phone: while the app is open, a new message in another conversation shows a banner; the conversation you are looking at stays quiet, approvals always show (#4310, #4551).
- Server: per-member write rate limits — sending messages, scheduling and starting uploads answer 429 with Retry-After past the limit, and the first refusal leaves one audit row (ADR-0208 addendum 1, #4234, #4521).
- Server: the cohosted-agent status for operators reports `environment{platform, loginRelay}` (ADR-0203 addendum, #4337, #4548).
- Server: plugin catalog display fields (logo key, category, starter prompts, website URL) and the apps a message asks for; "my app runtimes" lists where each of your apps runs (ADR-0113 addendum 3, #4313, #4491; migration 149).
- Phone: the approval card for `member.avatar.set` shows the proposed photo before you approve (#4394, #4408).
- Phone: the composer opens into the editor as soon as you tap it (not only after the first character) and folds back with the same spring when the keyboard goes down (#4456, #4515).
- Web and phone: the "agent work" card says "not picked up yet" with a Cancel for runs no agent has collected for a while, and hides system work (welcome runs) from the home card (#4285, #4513).
- Decisions (docs): host ops team box — shell only inside the box, typed actions in oort itself (ADR-0210, #4347, #4470); notification settings v2 — diagnostics, channel levels, keywords, phone delay while the desktop is active, sounds (ADR-0206, #4223, #4490); cohosted Hermes environment facts and the hosting suggestion copy (ADR-0203 addendum, #4336, #4459).

### Changed
- Phone: the default appearance is Light (choices in the order Light · System · Dark); a choice you already made is kept; the launch screen is light and the keyboard follows the app's appearance (ADR-0189 addendum 5, #4526, #4558).
- Repository: Dependabot is removed; dependency advisories stay a required CI gate (#4565).
- Server: an attachment that no message carries yet (a composer draft, or a file a scheduled message holds) is readable by its uploader alone; everyone else gets the same 404 as an unknown id (ADR-0151 addendum 1, #4233, #4454).
- Server: when another member signs in on the same phone install, they take over the dormant device row; deleting another member's dormant device is a 404 (#3978, #4452).

### Fixed
- Phone, web and desktop: editing a message keeps its thread summary and reply quote, and an edit for a message you have not loaded no longer inserts a half row (#4450, #4554).
- Phone, web and desktop: a message with only a photo no longer shows as an empty message in the conversation, lists and notifications (#4294, #4451).
- Web and desktop: the reconnect recovery marker appears only when someone else's new messages were brought in, the same rule as the phone (#4328, #4447).
- Web and desktop: a late read that comes back after you switched channels no longer mixes into the new channel (#4438, #4464).
- Phone, web and desktop: editing a message with a photo no longer drops the photo card in real time (#4441, #4465).

## [0.1.37] - 2026-10-25

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.37>. Tag target: `main=a41298d60`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres lists. Three database migrations (146, 147, 148; the schema goes from 145 to 148) and changes to `bootstrap_runtime_roles.sql` (a read-only lock on three catalog tables, `mem_*` EXECUTE for `momo_app` only, and column-level SELECT for the notifier); the api pre-deploy `momo-migrate` re-applies the runtime roles. Two new environment variables, both optional with defaults and no setting needed (`MOMO_RUN_WOKEN_EXPIRE_MINUTES`, default 30; `MOMO_WELCOME_HOSTED_SIGNAL_HOURS`, default 24). The Postgres image pin in the Railway catalog moved to 18.6; upgrading a running instance is a separate step (#4370) and is not part of this release. This release adds server-side DM closure, agent-proposed profile photo changes, tighter database role locks, the scheduled-message screens for web and desktop, and phone message bubbles, a profile photo flow and a long-press sidebar menu.

### Added
- Server: an external agent that was woken by the doorbell but never collected its job is now ended after 30 minutes as `timed_out{woken_not_collected}` with an honest line, and a hosted agent with no work signal for a day is not picked for welcome runs (ADR-0200 addendum 3, #4284, #4359, #4365).
- Server: DM closure is server state — closing a DM on one device closes it everywhere, and conversations with members who left are closed by default (ADR-0177 addendum, #4227, #4335; migration 146).
- Server: an agent can propose changing *your own* profile photo from an attachment in the same conversation; you approve it on a preview card (`member.avatar.set`, ADR-0186 addendum v4, #4385, #4398; migration 148). The card UI follows in #4394.
- Phone: change your profile photo from the profile sheet — pick, take, crop, remove (#4384, #4391).
- Phone: long-press a channel or DM in the sidebar for copy, read/unread, mute, leave and close conversation; closed DMs live under "⋯ › Closed conversations" (#4229, #4366, #4367, #4396).
- Phone: Buzz-style message bubbles with rounded press/landing faces, and a sent message rises from the composer (respects Reduce Motion) (#4300, #4388, #4383, #4400).
- Web and desktop: scheduled messages (#4215, #4275).
- Security: claims-to-tests mapping (`docs/security/claims.yaml`, ADR-0214) and a "what oort does not do" section (#4224, #4389); a PR CI "Security pack" lane that runs the tenant-isolation, auth and approval PG tests (#4241, #4378); a required dependency-advisory lane (#4243, #4358); `unsafe_code = "forbid"` across the server workspace (#4246, #4373); tenant catalog invariants (#4242, #4371).

### Changed
- Phone: the composer is a one-line pill that expands into an editor while you type and returns to one line after sending; no haptic while typing (#4305, #4368).
- Web and desktop: composer tool row (+ · mention · emoji · format) with a context band; message rows get a soft hover, a pill toolbar and shared tooltips; DM closure syncs across devices (#4317, #4379, #4324, #4392, #4228, #4360).
- Web and desktop: "Create GitHub app" no longer shows an example that looks like a value, names the app after the host, and warns that GitHub may ask you to confirm access (#4333, #4374).
- Server: Postgres image pinned to 18.6 with a version floor test (#4244, #4369). The running team instance is upgraded separately (#4370).
- Server: runtime roles lose write access to three RLS-off catalog tables, and the ten `mem_*` SECURITY DEFINER functions are executable by `momo_app` only (#4372, #4387, #4381, #4395; migration 147).

### Fixed
- Server: realtime connection tokens no longer outlive the access token they are bound to, so subscriptions opened just before expiry are not refused with 403 (#4311, #4364).
- Server: gateway usage reported with camelCase keys is recorded instead of silently becoming zero (#4375, #4380).
- Phone: the conversation no longer shifts while typing (the activity line keeps its height) or on reconnect, the photo viewer controls sit inside the safe area, and the return key inserts a newline (#4331, #4357, #4292, #4327, #4293, #4329, #4321, #4330).

## [0.1.36] - 2026-10-23

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.36>. Tag target: `main=16780cb3f`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres lists. One database migration (145, the schema goes to 145) and one new block in `bootstrap_runtime_roles.sql` (the same `scheduled-message-lockdown` text as the migration). New environment variables are all optional (`MOMO_SCHEDULER_ENABLED`, `MOMO_SCHEDULER_TICK_MS`, `MOMO_SCHEDULER_BATCH`, `MOMO_SCHEDULER_GRACE_SECONDS`). This release adds the scheduled-message server, a theme catalog with text size, chat density and wallpapers, a desktop glass background, a new phone attach menu, and the Railway wiring that keeps the GitHub App key and public address on the api only.

### Added
- Server: scheduled messages (ADR-0208, #4214, #4257, migration 145). A person can schedule a text message, with attachments, to a channel, a DM or a thread from 60 seconds to 120 days ahead, and the api process sends it at its time through the same send path as an ordinary message (one transaction: channel sequence, message and outbox), even when the sender's device is off. Five routes: create, list, change, delete and send now. At most 50 pending schedules per member and workspace, 20 attachments each. The body is readable by its author only (owner-scoped row-level security), is erased once the schedule is sent or cancelled, and rows are purged after 7 days (sent, cancelled) or 30 days (failed). A password change or reset, a suspension, a device unlink or refresh-token reuse stops the affected schedules as failed (`sessions_ended`) until the author looks at them again; removal and leaving cancel them; signing out does not. The tick runs every 5 seconds in the api process on its own two-connection pool and refuses a database role that skips row-level security; a schedule that cannot be sent within 60 minutes of its time fails (`missed` or `send_error`). New objects: the tables `scheduled_message` and `scheduled_message_attachment` (row-level security forced), the NOLOGIN role `momo_sched_definer` that owns two id-only SECURITY DEFINER functions in the schema `momo_schedule_private`, the `scheduled-message-lockdown` block in both role bootstrap files (the relay, worker, notifier and platform-admin roles hold no privilege on the tables), the personal-channel event `scheduled_message.updated`, five audit kinds that never carry the body, and the `oort doctor` check `stack.scheduler`. `MOMO_SCHEDULER_ENABLED=0` turns the scheduler off visibly: creating, editing and sending now answer 503 `scheduler_disabled`. The screens are not in this release (#4215, #4216).
- Shared core: the scheduled-message module for web and phone (ADR-0208 D16, #4237, #4263): types, the API client, the presets (tomorrow 9:00, next Monday 9:00, custom), the event revision merge, the copy table and the pre-send decision. No screen uses it yet.
- Web and desktop: the theme catalog (#4188, #4256). Settings › Appearance offers 57 catalog themes (light and dark counted separately), derived from permissively licensed upstream palettes (GitHub, Catppuccin, Nord, Solarized, Gruvbox, Dracula and others), beside the three own themes, with a gallery. Every text and non-text contrast is corrected to the same floors; the upstream notices ship in `legal/generated/THEME_PALETTE_NOTICES.txt`.
- Web and desktop: text size (small, default, large) and chat density (compact, comfortable, spacious) with a live preview (#4189, #4225). The default setting looks exactly as before.
- Web and desktop: wallpapers (#4191, #4266). Settings › Appearance › Background puts a solid color (eight), a built-in picture (six) or your own photo behind the sidebar and the window edge, under a readability layer whose opacity is a computed floor per theme and mode. The photo stays on the device only (shrunk, location data removed) and is erased when you pick another background or sign out. Choosing a wallpaper locks the glass background.
- Desktop (macOS): a glass background you can switch on, with an opacity slider (#4190, #4254).
- Desktop: creating the GitHub App from the desktop app (ADR-0205 D2, #4220, #4251). The default browser opens GitHub's "Create GitHub App" screen without an oort sign-in, the browser lands on a short result page, and the app window reads the new state when it regains focus. The GitHub card in the apps list leads the instance operator there.
- Phone: the attach menu (#4180, #4181, #4183, #4219, ADR-0168 addendum 1). A card grows out of the + circle with camera, photos and files; "Photos" turns the card into a grid of recent photos, and the photo library is asked for only when you tap "Allow". New dependency `expo-media-library` (MIT).

### Changed
- Phone: the + and send circles of the composer pill sit concentric with the pill's end caps (one 36 pt circle, 9 pt on every side), and an empty field shows only the first clause of its hint when the whole sentence does not fit on one line (#4179, #4184).
- Phone: the gap between the last message and the composer pill is 20 pt instead of 36 pt (#4264, #4271).
- Web and desktop, no visible change: the appearance store is v2 with a root-attribute stamp table, CSS fragments and layer variables (#4186, #4217), and the scrim arithmetic moves into the shared core with a per-theme floor `scrimFloor` (#4187, #4204).
- Infra: the Railway catalog gives the api `MOMO_PUBLIC_BASE_URL` (`https://${{shared.OORT_SITE_ADDRESS}}`), and its checker keeps the GitHub App master key and the public address on the api only (#4221, #4250).

### Fixed
- Web and desktop: while notifications are paused (or do-not-disturb is on), the OS banners for mentions, approvals, DMs and terminal-pane replies no longer appear, following the server rule; the badge and the inbox still fill (#4197, #4210).
- Web and desktop: the completion panel of the "+" new-workspace dialog shows the workspace ID with a copy button and the right sign-in steps, instead of a slug sentence the sign-in form rejects (#4198, #4211).
- Web, desktop and phone: a conversation with a member who has left folds by default when nothing from a person is unread (a quiet row "N conversations with former members" opens them), and a personal agent you switch off leaves the sidebar at once (#4252, #4277).

### Docs
- ADR-0208 (scheduled messages: design, API contract draft, UI spec; #4213, #4232), ADR-0189 addendum 3 (theme catalog, open themes, wallpapers, glass floor; #4185, #4205), the public security statements aligned with the current Rust code (#4199, #4207), and the README rewritten with seven language editions (#4265, #4270).

### CI
- Two web tests no longer race: the stranger test of the Hermes model section waits until the answer reaches the screen (#4208, #4268), and the H-1 runtime press test waits for `transitionrun` instead of a frame count (#4269, #4274).

## [0.1.35] - 2026-10-21

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.35>. Tag target: `main=a1f811246`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres lists. No database migration (the schema stays at 144) and no change to `bootstrap_runtime_roles.sql`. No new environment variables. This release closes the security-review follow-ups of the same-server Hermes model picker and makes the GitHub webhook answer 401 before anything about its configuration.

### Changed
- Server: the same-server Hermes model picker follow-ups from the independent security review (#4159, #4167). Hermes's current `(provider, model)` counts as `current` only when the provider is one of the logged-in providers, and connecting no longer pins a provider that is not logged in. Saving a model answers `409 cohosted_agent_pin_replaced` when the pin became a team link at that moment (and `cohosted_agent_not_connected` when there is none or it is disconnected). The model id is capped at 64 bytes in code with a 128 backstop in the CHECK, and the throttle of `GET models` / `PUT model` runs before any database read. There is no model block list (ADR-0203).
- Server: a GitHub webhook with a missing or malformed signature answers 401 before the master key is looked at, so an unsigned caller no longer sees whether the instance has a GitHub surface (#4160, #4164). Only a well-formed signature that cannot be checked because the key is missing answers 503.
- Web and desktop: the Hermes "model" section shows the current model once, keeps the saved notice in a fixed place, and "show all" / "recommended only" carry an underline cue that they can be pressed (#4161, #4165).
- Web and desktop: the avatar grammar reaches the remaining surfaces, and the per-member hues keep a minimum distance from the status colours (#4162, #4171).

### Fixed
- Server: the 503 body that anonymous callers get from the GitHub webhook receiver and the setup redirect when the key is missing no longer names an environment variable; the cause is logged on the server only (#4168, #4172).
- Web and desktop: the list selector no longer hides its label in a narrow pane, scrolls the page under a modal, or misses type-ahead, and a disabled item is announced with `aria-disabled` (#4131, #4169).

## [0.1.34] - 2026-10-20

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.34>. Tag target: `main=b90a77b3`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres lists. One database migration (144, the schema goes to 144) and no change to `bootstrap_runtime_roles.sql`. No new environment variables. This release lets the operator pick the model the same-server Hermes answers with, and folds the AI settings into one place.

### Added
- Server: choosing the model the same-server Hermes answers with (ADR-0203 addendum, #4143, #4149, migration 144). `agent_provider_pin` gets a `model_provider` and `model_id` pair (both NULL means unchanged; only an `operator_env` pin may carry it; three CHECK constraints; the existing row-level security is untouched). Two operator-only routes are new: `GET /v1/workspaces/{ws}/cohosted-agent/models` lists the logged-in providers with their models (the first three per provider and the current one are `featured`), and `PUT /v1/workspaces/{ws}/cohosted-agent/model` sets the pair and answers `422 cohosted_model_not_offered` for a model outside the list. The agent worker sends the provider and model together in the `/v1/chat/completions` body; without a pair the request is byte-identical to before. Connecting now records Hermes's current provider and model in the pin, and still connects if the options cannot be read.
- Web and desktop: the AI hub Hermes card gets a "model" section ("the model answering now" with a listbox to change it, "show all" for the rest of a provider), and the "model sign-in" block folds the providers that are already logged in (#4145, #4151).

### Changed
- Web and desktop: the settings table of contents joins "AI connection" and "AI hub" into a single "AI" row, `?section=ai` opens `/ai/accounts`, and the same-server Hermes card moves to the top of every AI hub section. Connecting shows a "Hermes connected" notice and creates the operator-Hermes DM in the sidebar with an "open conversation" link (#4141, #4144).
- Web and desktop: the "set status" emoji picker is a popover attached inside the text field, and picking a suggested status fills the emoji, the text and the expiry at once (#4140, #4147).
- Web and desktop: the default sidebar DM avatar has a border, and people get a per-member hue so the circle is visible (#4148, #4150).

### Fixed
- Web: a closed DM comes back only when a new message a person would read arrives; the system messages that pile up in an agent DM no longer revive it (#4142, #4146).

## [0.1.33] - 2026-10-20

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.33>. Tag target: `main=81eb800a`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres lists. No database migration (the schema stays at 143) and no change to `bootstrap_runtime_roles.sql`. No new environment variables. This release is the 0.1.32 on-device feedback pass: one server fix and UI polish.

### Changed
- Web and desktop: the native selects are replaced by the app-drawn `ListboxSelect` listbox: the do-not-disturb and pause "until" list (#4106, #4119), the status-setting expiry field (#4123, #4124), settings and routing (#4126, #4132), jobs and workbench (#4128, #4130), and memory, hub, plugins, directory and AI hub (#4127, #4129).
- Web: the "notifications paused" card sits above the profile row so the profile row no longer shifts up (#4107, #4120).
- Desktop: the sidebar section-head hover highlight covers the whole head box, the "..." menu sits inside that box, and the empty-section copy is reworded (#4108, #4118).
- Web: the "visible in this workspace" chip is removed from the profile head and kept for read-aloud only (#4109, #4122); the team AI key "limit and remaining credit" block is removed and only the console link line remains (#4110, #4115).
- Web: the same-server Hermes connect prompt appears once, on first discovery, as a "connect?" dialog; with a risky-tool signal the choice is made in the card instead, and the details fold has an arrow and alignment (#4113, #4121).

### Fixed
- Web: the command palette (Cmd+K) filter no longer matches on id and alias subsequences, so it filters again; an "AI connection" entry and the settings table-of-contents row are added (#4111, #4114, #4125).
- Server: `/v1/toolsets` entries with `enabled:false` are judged as off, which fixes the same-server Hermes tool misjudgement (#4112, #4116).

## [0.1.32] - 2026-10-20

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.32>. Tag target: `main=ddd4dd45`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres lists. Migrations 141-143 (schema 140 to 143); `bootstrap_runtime_roles.sql` gains one grant (`momo_notifier` SELECT on `channel_viewing`). New environment variables are all optional (`HERMES_LOGIN_RELAY_URL`, `HERMES_LOGIN_RELAY_KEY`, `HERMES_APP_LOGIN_GOOGLE_PUBLISHING`, `HERMES_BASE_URL`, `HERMES_API_KEY`).

### Added
- Server: the "watching" presence signal (ADR-0204 addendum 3, #4018, #4059, #4063, #4064, migration 141). Channel screens on phone, web and desktop send a heartbeat, and the server decides the 30-second "watching" window from the new `channel_viewing` table (RLS enabled and forced; the notifier role reads it).
- Server: the official app catalogue is seeded from measured vendor tool lists (ADR-0113 addendum 2, #3944, #4068, migration 143). GitHub, Notion and Linear manifests are replaced (tool names are now the vendor names), and Gmail, Google Calendar and "My Drive" are added. Capability projections of existing grants of the three replaced apps are rebuilt.
- Server and web: GitHub intake (ADR-0205 D3-D6, #3954, #3955, #4070, #4083, #4084, #4087, #4088, #4090, migration 142). Installation, repository and channel-subscription tables with row-level security, an unsigned-webhook 401, spoof-proof notification props, a `linked_elsewhere` setup redirect, and the notifications screen (operator registration, workspace link, channel subscription, rendering). The GitHub surface stays off until `GITHUB_APP_MASTER_KEY` is set.
- Hermes in one step (ADR-0203, #3952, #4071, #4072, #4076, #4082, #4091, #4092): a compose `agents` profile, a Railway `hermes` service definition with a fail-closed tool-lock gate, a model-provider renderer, and hermes-kwak model auth through a subscription OAuth (Codex first, Claude fallback). It is not switched on for the team instance yet.
- Hermes login relay (ADR-0203 addendum, #4073, #4074, #4078, #4079, #4080, #4081, #4093, #4094, #4095, #4096, #4097): a fixed-command sidecar, an operator-only relay API with a zero-byte token boundary test, the model-auth screen and per-app login. Without the relay key the API answers 409 `login_relay_off`.
- Server and web: the `app_notice` wire and a "used app" mark in `message.props` (ADR-0113 addendum 2 E8-E10, #3950, #3951, #3949, #4052, #4054, #4057, #4061, #4085): the phone "Apps" read screen, app screen v2 with preview chips, two Drive chips, where it runs and tool grades R/A/B.

### Changed
- Phone and web: the iPhone SE keyboard gap is 4 pt and the web DM normal-state notice is gone (#4044, #4050); the "agent" badge next to message names is removed and kept for read-aloud only (#4065, #4066).
- CI: the PR cargo lane also runs for `openapi.yaml`, `docs/api` golden and vector changes, and for the paths Rust tests read outside `server-rust` (#4042, #4053, #4055, #4060).

### Fixed
- Web: the `useAppNotice` system row no longer duplicates, and the Port `login_lost` message is neutral (#4058, #4062).

### Docs
- ADR-0204 addendum 2 (wording of "declined", `momo.stream.provisional`, cancelled-stream push; #4045, #4051), the Agent Port `complete` null `messageId`/`seq` note (#4046, #4049), the subscription-OAuth ADR addenda (#4071, #4075), the login-relay design (#4077) and the Hermes K-S1b trial preparation (#4067).

## [0.1.31] - 2026-10-18

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.31>. Tag target: `main=38695c43`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. Two database migrations (the schema goes from 138 to 140): 139 `agent_connector_owner` (one nullable `agent` column plus a CHECK) and 140 `github_app` (five tables, all with row-level security enabled and forced). `bootstrap_runtime_roles` is unchanged. New environment variables, all optional: `GITHUB_APP_MASTER_KEY` (without it only the GitHub surface answers 503), `MOMO_PUBLIC_BASE_URL`, and `OORT_COHOSTED_AGENT_CONNECTOR_APPS` (unset means the connector trial is off). Deploy order: the push relay, the API (the pre-deploy step applies 139 and 140), the agent worker, the relay and the webhook sender, then the notifier.

### Added
- Server: an agent that has connected apps is called only by its owner (ADR-0113 addendum 2 E3, #3938, #4031). The agent gets a `connector_owner_human_id` mark that must equal its owner (a database CHECK), and delivery drops a trigger written by anyone else, so an owner's Gmail or Drive access is never used for someone else's request. Turning it off is immediate.
- Server: the GitHub App is stored and sealed (ADR-0205, #3947, #4033). Five tables, a manifest flow and the `GITHUB_APP_MASTER_KEY` sealing root. Until the key is set, the GitHub surface answers 503 by design.
- Server: the "connector trial" switch (#3948, #4037). It is operator-only, limited to one person, needs two attestations, and re-checks right before delivery. It is off unless `OORT_COHOSTED_AGENT_CONNECTOR_APPS` is set.
- Server: plugin groundwork (ADR-0113 addendum 2, #3937, #3945, #3946, #4027, #4034, #4035). The manifest validator accepts `LicenseRef`, several protocols and `momo.preview` and allows no class C; tool grants are recorded with their basis and audited (not enforced); a `connector.tool_used` audit row and a "used app" meta field are written.
- Server: an agent can suggest `settings.open {section}` from a four-place allow list (ADR-0201 v2 H6-4, #3939, #4028).
- Web and phone: the "Install app" switch with a two-line consent window, a one- and two-cell connection state and the admin or no-admin notice (ADR-0113 P3, #3943, #4036). The settings-open suggestion is drawn as a card (#3940, #4032).
- Web and phone: "Replying" replaces the receipt line while an agent works (#4020, #4024).

### Changed
- Server: consecutive messages in a 1:1 DM are merged, and the placeholder for an empty successful reply is gone (#4017, #4023).
- Phone: the DM screen's keyboard gap, header face and status dot, normal-state notice and recovery marker were tidied (#4016, #4038).

### Fixed
- Phone: a 401 while registering the push device no longer ends registration for good; it can retry when the refresh could not reach the server (#4008, #4021).
- Desktop: the update gauge that stuck at "0 B" now shows "Downloading" with an indeterminate bar (#4019, #4022).
- Core: particles after a Latin-script name follow how the name is read (#4025, #4026).

## [0.1.30] - 2026-10-17

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.30>. Tag target: `main=73deda08`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. No database migration (the schema stays at 138). `bootstrap_runtime_roles` is unchanged. No new environment variable. Deploy order: the push relay, the API, then the agent worker (the new producer), the relay and the webhook sender, and the notifier last, so that no new push candidate reaches a notifier that cannot judge it.

### Added
- Server: a streamed agent reply now gets its push decision again when it closes (ADR-0204 addendum 1 D8-a, #3987, #4003). If you called an agent and stepped away, the finished reply reaches you as one push per device. The stream's opening and its closing are two producers of the same push candidate and the existing collapse id and dispatch log keep them from sending twice. A stream that is still open is held back, and a turn that will be retried leaves no half-answer push. A cancelled or failed stream is announced too, because a stop is also the end of an answer.
- Phone: the lock-screen Approve / Deny buttons are handled by a native handler that sends one decision with the `push_action` token and replaces the notification with a one-line result, so they work while the app is closed or suspended (ADR-0204 D6, #3931, #3994). An approval whose sender and text the notification extension could not fill is lowered to "open to decide", and the lock-screen word is "Deny" everywhere. Device behaviour is runtime-unverified until the device matrix runs on a phone.
- Phone: the first-run notification step is "What notifications do you want?", with a preview of each kind and a switch for "work finished" (ADR-0204 D4, #3925, #3975).
- Phone and web: a paused notification state is visible. The phone inbox and the web sidebar show one line, "until ... · turn back on" (ADR-0204 D3, #3923, #4002).
- Web and desktop: an agent's status is a dot on its avatar instead of the word "off". A filled dot means signals are arriving; a hollow ring means a reply is unlikely (#3964, #3985).

### Changed
- Web and desktop: sidebar channel and DM rows share one hover and right-click behaviour. A DM shows an X on hover that closes it in the sidebar on this device only (it comes back with a new message; a DM with unread messages has no X), the right-click menu follows a fixed order, the outline that appeared after a right-click is gone, and the gesture that opens the menu can no longer trigger an item (#3963, #3984).
- Phone: pull to refresh shows its progress as the satellite's orbit angle, and a failure notice stays until the next pull instead of disappearing on a timer (#3992, #4006).

### Fixed
- Web, desktop and phone: a session refresh that could not reach the server is no longer treated as a login expiry. Only a refresh the server rejects ends the session; avatar and attachment downloads on the phone follow the same rule (#3993, #3997, #3995, #4007).

## [0.1.29] - 2026-10-17

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.29>. Tag target: `main=3475f06c`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. No database migration (the schema stays at 138). `bootstrap_runtime_roles` gains two column-scoped grants for `momo_notifier`, both additive: `UPDATE (invalidated_at, updated_at)` on `push_token` and `SELECT (workspace_id, member_id, role)` on `workspace_membership`. No new environment variable. Deploy the push relay before the app: the relay now accepts the `momo.approval.open` notification category, and a push with that category is rejected by an older relay.

### Added
- Server: a lock-screen approval credential (ADR-0204 D6, #3927, #3977). A `push_action` token lasts 6 hours and is good for one allowed path only; an approval that has to open the app answers 403 `opens_in_app`.
- Server: approval notifications are split into their own category, `momo.approval.open`, and an approval push goes only to people who may decide it (ADR-0204 D7, #3928, #3971).
- Server: pushes for an agent you called (ADR-0204 D8, #3929, #3986). The reply, the expiry and the stop of an agent you mentioned reach you as the new wire reason `mention`; nothing is sent while you are watching (a 30-second "watching" window).
- Server: plugin install, grant and revoke write paths, four official plugins (ADR-0113 P3, #3914, #3965), and the team AI helper's `plugin.install` approval card now runs through the same domain function (ADR-0201 v2 H7, #3889, #3967). This is the item the 0.1.28 notes listed under "Not in this release".
- Phone: "Push notifications" is a switch for this phone (ADR-0204 D1, #3924, #3974). Turning it off removes only this device and the app does not register it again by itself.
- Phone: pause and do-not-disturb take an end time, and the pause says that notifications pause with it (#2899, #3991).
- Web, desktop and phone: the oort loader ("orbit"), used for lost connection, reconnecting and first loading (#3961, #3972); on the phone, pull to refresh uses it with haptics, and the failure, offline and empty states are covered too (#3962, #3989).

### Changed
- Web and desktop: the "Apps" screen is read-only, and showing apps and installing one follow what the server reports (ADR-0113 addendum P-U1, #3860, #3966).
- Phone: the notification arrival highlight no longer lingers after an approval; it clears as soon as the approval is decided and, after a move, two seconds later, and a held finger keeps it (#3921, #3979).

### Fixed
- Server: when APNs answers 410 or BadDeviceToken, the notifier invalidates that device token instead of retrying it (ADR-0204 D9, #3930, #3973).
- Phone: an approval decision that meets a 401 refreshes the session and retries, and a decided approval is removed from the notification tray (ADR-0204 D6, #3926, #3968).
- Release: the `server-rust/Dockerfile` dependency-cache COPY list is checked against the workspace members in every PR, so a new crate can no longer break only the image build (the 0.1.27 publish failure, #3876, #3917).

### Documentation
- ADR-0204 phone notifications v2 and its addendum 1 (#3922, #3934, #3988, #3990); the plugin v2 ADRs: ADR-0113 addendum 2, ADR-0188 section 8.9, ADR-0203 addendum and ADR-0205 (#3935, #3970).

## [0.1.28] - 2026-10-16

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.28>. Tag target: `main=31d03297`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. Three database migrations since 0.1.27 (136-138): the schema moves from 135 to 138. 136 adds the RLS FORCE table `agent_provider_pin` (one row per agent, a link reference only, no credential columns; writes need the instance-operator `app.provider_link_admin` setting); 137 adds the RLS FORCE table `provider_key_budget` (the operator-entered monthly credit per provider, operator-only) and 11 global Anthropic `model_pricing` rows; 138 adds the RLS FORCE table `member_handle_alias` with a trigger on `member`, the column `usage_ledger.web_search_requests`, and the new read-only role `momo_helper_read` (NOLOGIN, NOBYPASSRLS, SELECT only). `bootstrap_runtime_roles` grants `momo_helper_read` to `momo_worker` with INHERIT FALSE (SET only) and revokes it from the other runtime roles. Two new optional environment variables, both with defaults: `TEAM_AI_DAILY_SEARCH_CAP` (default 50) and `OORT_COHOSTED_AGENT_TOOLS_LOCKED` (unset means the Hermes connect button stays off).

### Added
- Server: per-agent AI connection pin (ADR-0147 addendum, #3873, #3880). An instance operator can pin one agent to the operator-env link (`HERMES_BASE_URL`) or to a team link by chain position (`GET/PUT /v1/workspaces/{ws}/agents/{agent}/provider-pin`, migration 136), so the team Anthropic key and a Hermes on the same server can live in one instance. A pin that cannot be resolved never falls back to another link: the run fails with `pinned_link_unresolved` and the model is not called.
- Server: key check results, limits and monthly credit (ADR-0147 addendum, #3886, #3895). A new check outcome `provider_no_credit` for billing problems, the OpenRouter credits read, `GET /v1/provider/limits` and `PUT /v1/provider/limits/budget` (operator only) with the operator-entered monthly credit and an estimate of this month's spend from `usage_ledger` tokens times `model_pricing` (migration 137). The estimate is labelled as oort's own count, not the provider's balance.
- Server: a Hermes on the same server is detected and connected with one click (ADR-0203, #3874, #3881, #3883, #3897). `GET /v1/workspaces/{ws}/cohosted-agent`, `POST .../probe` and `POST .../connect`, operator only. It dials only the host the operator declared in `HERMES_BASE_URL`, on fixed paths (`/health`, `/v1/models`), and refuses to connect unless the operator has attested the tool lock (`OORT_COHOSTED_AGENT_TOOLS_LOCKED`); with the variable unset nothing is shown and no request is made.
- Team AI "oort helper" v2 (ADR-0201 addendum v2, #3888, #3892, #3894, #3899, #3900, #3901). The helper answers to `@oort`, `@오르트` and `@claude` (migration 138 `member_handle_alias`; a real member's handle always wins), holds a general conversation, uses eight read-only tools that see only what the requester can see (the new `momo_helper_read` role), can use the provider's built-in web search under a daily cap (`TEAM_AI_DAILY_SEARCH_CAP`, default 50), and proposes settings approval cards for link previews, team memory off or paused, and the work tier. `plugin.install` is declared but answers that there is no install path yet. The helper still runs only in workspaces that turn on the `team_ai_fast_path` switch, which is off by default.
- Web and desktop: an eye button on API key fields to show or hide what you pasted (#3885, #3890); the "limit and remaining credit" block and the monthly credit input under AI > Team AI key (#3887, #3896); the per-agent "AI this agent uses" picker and the "Hermes on the same server" card (#3875, #3891); a next-step card after the helper is switched on, `@oort` / `@오르트` autocomplete, the helper answer footer (what it looked at, the model chip, numbered sources) and the "applies to the whole workspace" line on settings cards (ADR-0201 v2 S7, #3893, #3898).
- Desktop: an "Update" pill in the sidebar with a tooltip, a progress card, and an automatic relaunch after the install (#3904, #3909).
- Phone: a new-version banner on Home and in the profile sheet, fed by one static `ios-latest.json` and shown only when it names a newer build (#3905, #3910); theme choice (Dawn sky, Graphite, Sunset band) with four accent presets or a hex colour (DS2-7, #2719, #3911); a custom background of a solid colour, a bundled gradient or your own photo, always under a scrim so text stays readable (ADR-0189 addendum 2, #3907, #3912).

### Changed
- Phone: the agent screens are tidied. Home shows the agent-work header only while a turn is running, the agent detail drops the sleep/wake card, and agents with a photo show it instead of the robot square (#3902, #3906).

### Fixed
- Agent Port: a job whose run had already ended was handed out again at every lease expiry, which kept Grokbot stuck on "call refused" (ADR-0162 addendum 6, #3903, #3908). Jobs of ended runs are no longer claimable and are closed on the next claim; `oort_job_start {leaseHandle}` on an ended or parked run answers 200 with `closed` instead of 409; a stale lease handle no longer marks the hosted connection as faulty.

### Not in this release
- Running `plugin.install` from the helper's approval card (it needs the plugin install path, #3889).

## [0.1.27] - 2026-10-16

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.27>. Tag target: `main=80924663`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. No database migration (the schema stays at 135), `bootstrap_runtime_roles` is unchanged. One new optional environment variable with a default: `TEAM_AI_DAILY_TOKEN_CAP` (default 200000).

### Added
- Server: the server side of the team AI fast path (ADR-0201, #3835, #3837), which the 0.1.26 notes listed as not merged. The workspace gets an "oort helper" agent member and proposes four kinds of approval cards; it works only in workspaces that turn on the `team_ai_fast_path` workspace switch, which is off by default, and it stops at a daily token cap (`TEAM_AI_DAILY_TOKEN_CAP`, default 200000). New crate `momo-workspace-actions`.

### Fixed
- Release build: the container dependency-cache stage now copies the new crate's `Cargo.toml`, so the image builds again (#3876, #3877).

## [0.1.26] - 2026-10-15

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.26>. Tag target: `main=4084b77b`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. Four database migrations since 0.1.25 (132-135): the schema moves from 131 to 135. 132 and 133 widen the `agent_run_event` kind check (`doorbell_rung`, `tool_call`) and 133 adds the RLS FORCE table `agent_run_tool_tally`; 134 adds an `agent` column (default true); 135 replaces a function body only. `bootstrap_runtime_roles` grants `momo_notifier` SELECT on `agent_run_tool_tally`. Two new optional environment variables, both with defaults: `MOMO_DOORBELL_URGENT_GAP_SECONDS` (default 10) and `MOMO_HOSTED_INPLACE_GRANT_ENABLED` (unset means on).

### Added
- Server: the doorbell now records every wake signal on the run ledger as `doorbell_rung`, and a tracked job request wakes the agent at once instead of waiting out the cooldown, capped at one wake per connection every `MOMO_DOORBELL_URGENT_GAP_SECONDS` (#3822, #3830).
- Agent Port: the `oort_job_start` synthetic tool, with the recent conversation on claim (#3831, #3834); a tool-call ledger that keeps the tool name, duration and outcome of each oort call, at most 100 rows per run plus an exact per-tool tally, shown only with `include=tools` (ADR-0200 addendum, #3840, #3846); the closed result fields of `oort_run_complete` and `error.data` (ADR-0162 addendum 5 C1-C3, #3845).
- Agent Port: a human reply in a thread an agent opened wakes that agent (an `agent` column, default on; ADR-0162 addendum 5 W1-W3, #3851, #3855); calling a hosted agent in a channel it is not approved for raises an in-place "write in this channel" approval card, and approving it runs the waiting job exactly once (#3857, #3858). `MOMO_HOSTED_INPLACE_GRANT_ENABLED=false` turns the card off.
- Server reads: "running now" (`GET /agent-runs?state=active`, scoped to member channels, `scope=mine|team`, #3847, #3849); the board accepts `include=jobs` and `who=mine|team` (ADR-0202 E1, #3853, #3856); the official four-plugin list and detail read path in Rust (ADR-0113 addendum P-S1, #3859, #3861).
- Web, desktop and phone: attachment previews like Buzz with thumbnail chips, inline images and hover download (#3820, #3828); per-task duration, a status line under a sent message including the wake signal, and the phone task history (#3824, #3848); the Tasks screen shows results first with "mine / whole team" (ADR-0202 U1, #3842, #3850); agent profile card with inline name editing and consistent avatars in mentions and lists (#3821, #3862); the oort helper switch and "hand it to ..." wording (ADR-0201, #3836, #3844), which stays hidden against a server that does not know the switch; run cancel in the task panel and the phone approval follow-ups (#3852, #3854).

### Changed
- Web and phone: approving or rejecting is decided by a single tap, with no confirmation step (#3819, #3829); cards the server already decided hide their buttons (#3818, #3825).

### Not in this release
- The server side of the team AI fast path (ADR-0201, #3835, #3837) is not merged yet, so the helper switch does not appear. The backfill of past messages into the inbox.

## [0.1.25] - 2026-10-14

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.25>. Tag target: `main=b51ce8eb`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. Hotfix release: no database migration (the schema stays at 131), `bootstrap_runtime_roles` is unchanged, and there is no new environment variable.

### Fixed
- Agent Port: every Grokbot `tools/call` was rejected with -32602 `invalid tools/call params` from 2026-10-14 01:45 KST, because `momo-mcp` refused every key other than `name` and `arguments` and `arguments: null`, which blocked any client that sends the standard MCP fields (`_meta.progressToken`, `task`) (#3812, #3813). `tools/call` now accepts and ignores an object `_meta` and an object `task` and treats `arguments: null` as an empty object; `tools/list` (`cursor`, `_meta`) and `ping`/`initialize` (`_meta`) follow the same rule. Array or string `arguments`, non-object `_meta`/`task` and any other top-level key are still rejected.

### Added
- Agent Port: a -32602 rejection now logs a `Agent Port refused request params` warning with the method, code, message, and only the key names of `params` and `_meta` (no values), after authentication.

## [0.1.24] - 2026-10-14

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.24>. Tag target: `main=c82cb823`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. Database migration 131: the schema moves from 130 to 131; `bootstrap_runtime_roles` is unchanged. The server gains the `image` 0.25 dependency (avatar re-encoding). No new environment variable.

### Added
- Server: agent action scope v3 (ADR-0186 addendum, #3772, #3777). The base for handing a secret to an agent exactly once (`deliverSecretToAgent`, `secretClaim`, #3795); `agent.profile.update` for name, bio, status and role label through an approval card (#3797); agent profile pictures, where only the server's re-encoded PNG/JPEG (at most 512x512 and 512 KiB) is stored in the new `agent_avatar_image` table (migration 131, #3799) and the approver previews it before deciding (`GET /approvals/{approvalId}/avatar-preview`, workspace-file and generated-bytes sources, #3800); `agent.invite`, which creates an agent in the approver's name with a one-time pairing secret (#3801); `oort_action_claim_secret`, a single-use claim that mints the secret on claim (#3802); agent instructions and tool descriptions for the v3 flow (#3803).
- Web: a personal-assistant list and one-step Grokbot connection (#3778); Settings > Appearance > Font for body and code, defaulting to the system typeface (#3781).

### Changed
- Approvals: a decision that rewrites a card is announced as `message.edited` and a 409 now states the original decision (#3780); the approve button no longer reappears right after approving, and card copy is in the polite register (#3779).
- Typography: body text moves to 15 with heading, label and code tokens and a literal guard (#3776, #3782), and the phone role table keeps font and line in one place with size and weight guards (#3783).

### Not in this release
- The backfill of past messages into the inbox.

## [0.1.23] - 2026-10-13

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.23>. Tag target: `main=d1cbe68b`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. Database migrations 128-130: the schema moves from 127 to 130, and `bootstrap_runtime_roles` now grants `momo_notifier` SELECT/INSERT on `agent_run_event` and USAGE on its sequence. No new required environment variable.

### Added
- Server: honest run state, the run event ledger and liveness signals for hosted agents (ADR-0200, #3739). The ledger `agent_run_event` and the liveness table `hosted_agent_liveness` with lifecycle triggers, 200 rows per run and 30-day retention (migration 128, #3752); the run progress read API with queue position (`GET /agent-runs/{runId}/events`, `GET /channels/{channelId}/agent-runs/progress`, #3753); agent liveness (`GET /agents/{agentId}/liveness`) and the `oort_ping` MCP tool, with optional `MOMO_AGENT_PORT_LIVENESS_*_MINUTES` thresholds (#3754); the manual doorbell ring "wake again" (`POST /hosted-agent-connections/{connectionId}/doorbell/ring`, 60-second cooldown and 5 per hour per connection, migration 129, #3755); a thin realtime `agent.run.event` frame per ledger row (migration 130), the sweep that ends stalled hosted runs as `timed_out` (optional `MOMO_RUN_LEASE_ABANDON_HOURS` and `MOMO_RUN_UNCLAIMED_EXPIRE_HOURS`) and the ledger retention sweep (#3756); agent instructions that describe `oort_ping`, the stage convention and the limits (#3757, #3745).
- Web, desktop and phone: run status is judged from the server's phase and lease, and "signal lost" is shown only when the server says so (#3758); the work panel reads the server ledger (#3759); agent liveness labels and "wake again" (#3760); the phone shows the same task status and liveness labels from the shared core model (#3761).

### Changed
- Web, desktop and phone: approval cards the agent raised are no longer missed, and the new action cards are shown (#3751).

### Not in this release
- The backfill of past messages into the inbox.

## [0.1.22] - 2026-10-13

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.22>. Tag target: `main=2fce5eec`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. No database migration: the schema stays at 127 and `bootstrap_runtime_roles` is unchanged.

### Added
- Server: agent management actions v2 (ADR-0186 amendment). An agent proposes and a human approves: the action registry foundation with per-action schemas, in-transaction resolution and a cap of three pending proposals (#3715); `channel.create` composed with the proposing agent's membership and approved channels in one transaction (#3724); `channel.member.add` in the approver's name with resolved ids pinned (#3725); `agent.rename` plus a human `PATCH /agents/{agent}` and a name validator (#3726); `hosted.channels.grant` to widen an agent's own connection to approved channels (#3727); `workspace.settings.update` limited to `welcome_prompt` and `role_labels` (#3728); agent instructions that describe the new actions and their limits (#3731).
- Web, desktop and phone: onboarding keeps its progress per account and server and re-judges the seeded name on the server (#3704); the skip landing, connecting an agent to an empty channel and a note for non-admins (#3712); the main action on the "my tools" row turns on the personal agent (#3716); the re-ask gains "keep it as is" and clears stale markers (#3717).

### Fixed
- Web, desktop and phone: the inbox detail panel opens centered on the item's message and shows the author name and tone that match the list (#3703).
- Onboarding: a Claude subscription 409 is no longer misreported during the AI connect step (#3701).

### Not in this release
- Database migrations and the backfill of past messages into the inbox.

## [0.1.21] - 2026-10-11

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.21>. Tag target: `main=8fba6654`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. Two database migrations since 0.1.20 (126-127): 126 adds `inbox_item` (a per-recipient projection of mentions, quote-replies, thread replies and DMs, filled by triggers in the same transaction as the `message` insert; FORCE row-level security; ids and the member's own `read_at` only, no body copy); 127 adds the trigger that announces a fresh item on the recipient's personal realtime channel through the outbox. No data is dropped and there is no backfill of past messages: the inbox fills from new messages after the deploy. The runtime role `momo_notifier` gains `SELECT, INSERT, UPDATE` on `inbox_item` (its own message inserts fire the projection trigger). Rollback: whether a 0.1.20 app runs unchanged on schema 127 is to be confirmed by the deploy worker. Deploy order: push relay first, then notifier and server (migrations 126-127), then the desktop and phone apps.

### Added
- Server: the inbox projection `inbox_item` and its triggers (ADR-0199, #3682); the inbox API `GET /inbox`, `PUT /inbox/{id}/read`, `POST /inbox/read-all` with keyset pagination, the `inbox_item.created` outbox event, and a 30-day sweep of read items (#3683).
- Web, desktop and phone: the inbox reads the server projection and falls back to client-side assembly against an older server (#3685); the inbox is redesigned as a mailbox-style list of what relates to me with a context panel on the right (#3668).

### Changed
- Web and desktop: the sidebar drops "Conversations" and groups DMs in the Buzz style, with a new-DM modal and profile avatars (#3666).

### Fixed
- Phone: calling `@kwak-claude` is signed with the tool key (#3665); the @mention sheet floats outside the composer flow so the conversation no longer jumps (#3667).
- All clients: the "Direct message" fallback name is gone and DM names resolve in one function (#3678); a DM whose counterpart cannot be resolved still reads its history instead of staying on a skeleton (#3679).

### Not in this release
- Backfill of past messages into the inbox.

## [0.1.20] - 2026-10-10

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.20>. Tag target: `main=442049fd`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. Five database migrations since 0.1.19 (121-125): 121 adds `work_host_folder` (host-issued opaque folder ids and display names, never paths; FORCE row-level security); 122 extends `work_control` for the signed new-work spawn (`momo.human.control.v4`); 123 adds the personal-agent marker columns on `agent`; 124 adds `work_session.persona_member_id` (the personal agent a session was called as); 125 adds `agent.subscription_retired_at` and a trigger that refuses to revive the hosted connection of a converted or retired subscription agent. No data is dropped. Rollback: whether a 0.1.19 app runs unchanged on schema 125 (it does not read the new columns or tables) is to be confirmed by the deploy worker. Deploy order: push relay first, then notifier and server (migrations 121-125), then the phone app. Desktop 0.1.18 and older receive 404 from the removed `/v1/provider/work-host-engine`; update the desktop app.

### Added
- Server: personal agents (ADR-0198 amendment 1). An owner can turn a connected harness (Claude Code, Codex) into an alias member and switch it on or off (#3591); mentions and DMs route to it and its replies are authored by the alias (#3592); a signed new-work spawn (`momo.human.control.v4`) derives host and folder server-side (#3570); "my Mac is online" is one server-side rule (#3569); work-hosts reads expose the host-issued folder id and display name (#3590); the owner can stop a Mac session with `POST /work-sessions/{id}/kill` (#3628).
- Server: a tool to convert the subscription agent `kwak-claude` into a personal agent and to retire old subscription agents without deleting past messages (#3567).
- Core: `createAgentWorkRun` for sending a work request to an agent (#3587).
- Web and desktop: settings overhaul S1-S5c (icon list shell, profile and account on one page, appearance with color mode and accent, devices and run hosts, notifications and shortcuts, workspace, members and memory, usage and AI links) (#3578), the AI hub with two tabs and "my tools" harness cards (#3568), and a quieter sidebar profile row (#3574). The desktop DMG installer window has a background and Applications placement (#3642).
- Phone: "Hand off work" sheet (#3588), "Send to my Mac" with harness choice, ask and work request (#3597), live work detail updates (#3594) and a chat mode (#3595), stop work with one confirmation (#3596), the "AI" sheet in the + menu (#3598), board refresh on app return and push tap (#3589), and tab bar centering, haptics, tab motion and liquid glass (#3580).

### Changed
- Web and desktop: settings and dialog copy rewritten in plain polite Korean; the internal terms "root" and "command device" are gone (#3573, #3622).

### Fixed
- Server: another member's personal Mac is visible in the host list only as existing and online (#3583).
- Web: the command-device list re-reads while open, so a phone's late key registration shows up (#3577).

### Removed
- Server, web and desktop: the legacy execution engine settings API and UI for opencode, goose and codex-local (#3584, #3611). The route `/v1/provider/work-host-engine` is gone.

## [0.1.19] - 2026-10-06

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.19>. Tag target: `main=6558910e`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. **v0.1.18 was published but never deployed**: its `momo-notifier` had no privilege on `hosted_agent_connection`, so push judgment and the migration 120 trigger would fail with `permission denied` (#3553, caught in the pre-deploy check). 0.1.19 contains everything in 0.1.18 plus the fix. There is no new migration for the fix: the api pre-deploy re-applies `bootstrap_runtime_roles.sql`.

### Fixed
- Server: `momo-notifier` can read `hosted_agent_connection(workspace_id, agent_member_id)` (column grant only), so hosted work-run pushes and the `work.run.updated` trigger work under the production role; a production-role conformance test now runs push judgment, the push drain and the trigger as `momo_notifier` (#3554).

## [0.1.18] - 2026-10-06

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.18>. Tag target: `main=eff10223`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. Five database migrations since 0.1.17 (116-120): 116 adds the subscription-agent fields and device registration (ADR-0193 D14-D17); 117 adds `personal_provider_link` for personal API keys (FORCE row-level security); 118 adds `cloud_box` and its lifecycle control queue and 119 adds the box runner registration (personal cloud workspace, ADR-0197 M1-M2; both unused while `MOMO_CLOUD_BOX_ENABLED` is off, the default); 120 adds a trigger that emits the realtime event `work.run.updated` when a hosted agent's work run changes (ADR-0162 amendment 3 D13). No data is dropped. Deploy order for this release: push relay first, then notifier and server (migration 120), then the phone app, so the new `work_run_done` push reason is understood before it is sent.

### Added
- Server: external VM agents (for example Grok Bot on its own free VM) can be given work and tracked without a terminal view (ADR-0162 amendment 3, #3525). A team member can send a work request to a hosted agent (#3531; owner-only agents and guests are refused); the agent reports named stages with `oort_run_event` and a result with `oort_run_complete` artifacts (PR link, branch, added/deleted lines, commits) stored in the existing run output (#3529); hosted leases last 30 minutes by default (`MOMO_AGENT_PORT_HOSTED_LEASE_MINUTES`, 5-120) and renew implicitly on each report, so a VM that sleeps between wakes does not lose its job (#3532).
- Server: the team work board can include hosted agent work runs (`?include=runs`, opt-in so existing clients keep their `sessionId` rows), a realtime `work.run.updated` event, and a "work finished" push to the person who asked (`work_run_done`, iOS shows a fixed sentence) (#3533).
- Web, desktop and phone: agent work cards on the team board (status, latest stage, who asked, PR link), stage list and result in the run detail, and the latest stage and PR number on "work finished" activity rows. Stage, branch and title are shown as plain text only; the only link is a validated https PR URL, opened in the system browser on desktop (#3534).
- Web and desktop: the external agent connection wizard has a checklist for the second credential swap, preset picks (Grok Bot recommended, dots "coming soon") with doorbell prerequisites, likely causes when detection fails, and a 15-minute countdown for the connection value (#3526, #3527, #3528).
- Docs: the Grok Bot routine in `docs/SELF_HOST_AGENT.md` now claims the job, reports stages and completes with a PR link, with lease and error-recovery guidance and an owner checklist (#3535).
- Server, off by default: personal cloud workspace foundations (ADR-0197 M1-M3): the `cloud_box` lifecycle API and audit (#3504), the box runner and box image (#3509), and `momo-box-agent` with a Linux workd profile (#3503). The personal cloud workspace itself is paused and stays on the roadmap; nothing turns on unless `MOMO_CLOUD_BOX_ENABLED` is set.
- Research: S3 hardened box image and credential non-viewing check (#3490); S1 placement measurement, which closed the Railway adapter and kept the runner host (#3491, ADR-0197 amendment 1 #3502).
- Web, desktop and phone: an "AI" entry at the top of the sidebar with a hub overview, one shared vocabulary for agents, subscriptions and keys, and the old entry points linked to it (#3394, #3398).
- Server: agents now report their brain (team key, personal subscription, personal key), who can call them, their owner and whether their host is online; a subscription-agent registration endpoint. Claude subscription agents are off by default (`MOMO_CLAUDE_SUBSCRIPTION_AGENTS_ENABLED`) until Anthropic confirms the terms (#3401).
- Web and desktop: team AI keys in the AI hub (#3403), "My AI accounts" (#3404), and a single "sign in, then register" step for Claude Code on desktop that passes the value through `headersHelper` instead of the command line (#3419).
- Server: personal API keys. Only an operator issues them, only an owner-only agent resolves them, and there is no fallback to the team key (#3415).
- Research spikes for the personal cloud workspace (ADR-0197): Linux host key custody (#3417) and a blind PTY relay that only forwards ciphertext (#3418). Neither is turned on in a running service.

- Web and desktop: the AI hub agent table (`/ai/agents`): which AI each agent uses, who can call it, who pays, and its status, computed from the server fields in one place. Personal-key agents read "personal key, only me"; paused Claude subscription agents show a grey "inquiry pending" status. "Create agent" now offers three kinds (team, my subscription, external); my subscription is desktop-only (#3426, #3430).
- Web and desktop: the AI hub "External connections" page (`/ai/external`) gathers apps, incoming channel addresses (webhooks), outgoing notifications (event subscriptions), external agent connections and hosted bot invites in one list; the settings entries now open these pages (#3443).
- Web, desktop and phone: @mention suggestions show which AI an agent uses and who can call it, and a draft that mentions an agent who will not answer (someone else's subscription or personal key, or a paused Claude subscription agent) shows one warning line above the input (#3442, #3458).
- Web and desktop: personal API keys. Operators issue and revoke a key for one member on the team AI key page; the member sees received keys under My AI accounts and can make their own agent with it. The key value is write-only and never stays in the page, its state or its cache (#3470).

### Changed
- Phone: mention notes put the status first, mark when more agents exist, and keep the key clause at large text sizes; VoiceOver on iOS announces the warning line when it appears or changes (#3492).
- Server: while `MOMO_CLAUDE_SUBSCRIPTION_AGENTS_ENABLED` is off, nobody can take controller input (display attach or terminal attach) or answer "allow once" on a permission prompt in an already-open Claude session on a workspace-shared or cloud host; viewing stays open (ADR-0193 D18, #3477).
- Web: the mention routing row no longer overlaps at narrow widths and only lists agents that will answer (#3481); hosted agent screens use plain polite Korean and say "AI company" instead of "provider", checked by the preflight (#3480); agent credential rows fold instead of truncating names at 600-660 px (#3478).
- Server: while `MOMO_CLAUDE_SUBSCRIPTION_AGENTS_ENABLED` is off, Claude sessions are refused on workspace-shared and cloud work hosts (start, agent input, approval, session create and resume, the session-spawn tool, and the host's pending-controls poll), including standing auto-approvals and Claude launched through aliases or launchers such as `npx`. A member's own Mac and Codex are unaffected (ADR-0193 D18, #3457).
- Web, desktop, phone and server: AI wording follows one glossary ("AI screen", "team AI key", "my AI accounts", "owner and admins") in plain polite Korean, and a preflight check now rejects the retired terms in UI strings (#3448, #3452, #3467).
- Server: Claude subscription agents are no longer driven on someone's behalf while `MOMO_CLAUDE_SUBSCRIPTION_AGENTS_ENABLED` is off (the default), including agents registered before the flag existed. Mentions, 1:1 DMs, thread mentions, inbox fan-out, the welcome speaker and Agent Port tools skip them, work requests return 409 `claude_subscription_agent_paused`, and the agent posts a one-line notice at most every 10 minutes. Codex and personal-key agents, direct terminal use, Remote Control, and a member's own remote work session on their own Mac are unaffected (ADR-0193 D18, #3429).
- Web and desktop: the agents page status chips use the same status order and colors as the AI hub table (#3430).
- Phone: consecutive messages from the same person group tighter (6 pt) without a per-row time; the time is in the long-press sheet (#3387).

## [0.1.17] - 2026-10-03

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.17>. Tag target: `main=4d623fe1`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. **v0.1.16 was published but never deployed**: its `momo-notifier` ran the share retention sweep with a role that had no privilege on `work_session_share` and looped on `permission denied` (#3377); 0.1.17 contains everything in 0.1.16 plus the fix (#3378). Five database migrations since 0.1.15 (111-115): the schema goes from 110 to 115 on the api pre-deploy. 111 adds `member_avatar_media` (member profile photos: own-write only, composite FK, FORCE row-level security). 112 adds the `drive_reclaimed_at` marker for avatar Drive reclaim (rows are kept). 113 adds `work_session.origin` (`host` or `local_pty`) and `folder_label`, plus a trigger that refuses work-control creation on a shared local session. 114 adds `work_session_share` (shared summary S1, FORCE row-level security) and widens the `tool` CHECK. 115 adds `work_session.turn_started_at` and `notification_rule.work_complete_push` (default true). No data is dropped. There is no new migration for the fix: the api pre-deploy re-applies `bootstrap_runtime_roles.sql`. Rolling the app image back to 0.1.15 keeps schema 115: 0.1.15 does not read the new columns or tables, so only the new features turn off.

### Added
- Server: team work sharing (ADR-0190 D4, ADR-0194). Sharing a "My work" terminal pane to a channel posts a card in the home channel; only repo, branch, harness, status, phase, diff counts, PR URL and last activity (S1) reach the server, never terminal text, input or commit titles. The server refuses every input, run, read and terminate control on a shared pane. A "Team work" board and a read-only session detail (web, desktop, phone "Work" tab) show the same data.
- Web, desktop and phone: sidebar and notification rework. The rail is workspace-only (collapse with Cmd+B to destination icons), destinations sit under "Search and go", the message-search row is removed, the inbox ("Needs you") and the activity log are separate with a single source for the count, ink/amber pills and session status chips, desktop dock badge and OS notification kinds, opt-in browser notifications on web, and a phone tab badge.
- Server: "work finished" push (ADR-0120 appendix A). Sent only for a session you started, after a turn of 60 seconds or more, and only when you are not looking; it can be switched off in Settings.
- Server, web, desktop and phone: profile photos (ADR-0161 amendment). Upload, replace and delete in Settings; 4096 px and 5 MiB limits, 20 uploads per hour.
- Desktop: "My work" new-session start location (recent, folder, home; worktree off by default, ADR-0190 amendment D3-c), "Needs reply", lighter pane chrome, shortcut settings with rebinding and conflict detection, and a Cmd+K "collapse the explorer" command.

### Fixed
- Server: the notifier share retention sweep (30-day cleanup of shared summaries) now deletes through the `momo_app` (row-level security) pool instead of the BYPASSRLS notifier role; the delete URL is `MOMO_SHARE_RETENTION_DATABASE_URL`, falling back to `MOMO_HUDDLE_SWEEP_DATABASE_URL` (#3377, #3378).
- Server: minimal column-level SELECT grants for `momo_notifier` on `work_session_share`, avatar media, `workspace.avatar_media_id`, `huddle` and `huddle_participant`; every notifier loop backs off exponentially (up to 5 minutes) after consecutive failures; a conformance test runs the notifier jobs with the production role.

### Not in this release
- Desktop and phone app changes ship with the desktop DMG and iOS builds, not the image.
- The Drive reclaim job only runs on the Google Drive backend; oort-team uses the local backend (#3312).
- `oort://work` deep link (#2865), agent approval owner assignment (#3336), wider agent delegation settings (#3356).

## [0.1.15] - 2026-10-01

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.15>. Tag target: `main=a6e5cd1b`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. Thirteen database migrations since 0.1.14 (098–110): the schema goes from 097 to 110 on the api pre-deploy. 098 adds `agent.model_source` (backfill: `hermes-agent` models read `instance_default`). **099 drops the legacy memory plane** (ADR-0129: the eight tables `memory_item`, `memory_source_ref`, `memory_visibility_grant`, `memory_lifecycle_event`, `memory_candidate`, `memory_extraction_cursor`, `workspace_memory_policy`, `context_packet`, their functions, and three `workspace.memory_external_provider_consent*` columns); it has no consumers and the data loss is intended (ADR-0196 D11); the `vector` extension stays. 100–110 add the team memory v2 `mem_*` tables, definer functions and the `mem_definer` and `momo_memory` roles; every new table has FORCE row-level security, writes go through definer functions only, and `message` gets one RESTRICTIVE lock-down policy. Rolling the app image back to 0.1.14 keeps schema 110: 0.1.14 does not read `mem_*`, but the tables 099 dropped do not come back (0.1.14 does not use them either).

### Added
- Server: team memory v2 (ADR-0196, supersedes ADR-0129). Channel and thread summaries with daily and weekly roll-ups are written through the team "Default AI" summary row; without a row the worker makes no model call and fails honestly (`not_configured`), with a daily per-workspace token cap. Decisions, facts and commitments are extracted in the same call and only appended; they are visible only to people who can read every source message (RLS), and person-to-person DMs are never summarized.
- Server: agent replies carry summaries and items as reference material and leave a receipt, filtered by the reply channel (a 1:1 DM uses the union of the requester's permissions). "Remember this" proposals become memory only when a person accepts (not guests).
- Server: a memory browser API (list, search, detail, sources, history, edit, forget). Forgetting is an immediate permanent delete and the same content is not extracted again. A nightly job merges duplicates, closes decision windows, decays, deletes by retention and groups topics; it never changes what a person confirmed, and its changes can be undone.
- Server: local embeddings (multilingual-e5-small int8) so rephrased queries still find memory; memory text never leaves the instance. With less than 1.5 GiB of worker memory only embeddings switch off and search falls back to keywords. Workspace admins can reset memory, and a team notice says what goes to which provider.
- Web and desktop: a "what you missed" summary card, a "N memories used" chip and inspector, proposal cards, the memory browser (`/memory`), a decision timeline with undo, and Settings › Memory (switch, team notice, reset).

### Changed
- Server: control v1 is retired and resume-agent checks compare hosts (#3183); the model-source contract (#3176); the session permission card shows auto-allow (#3181); remote work account wiring (#3180).

### Not in this release
- Phone screens (summary card, chip, proposal card) ship with the iOS build, not the image.
- runtime-unverified: real summary model calls and nightly consolidation quality, embedding memory and latency on x86, on-device rendering.
- Follow-ups: #3189, #3201, #3211, #3225, #3234, #3236, #3243.

## [0.1.14] - 2026-09-29

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.14>. Tag target: `main=41d91d68`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. Six database migrations since 0.1.13 (092–097): the schema goes from 091 to 097 on the api pre-deploy. They add six tables (`work_permission_request`, `provider_default_ai`, `member_device_key`, `human_control_nonce`, `session_refresh_key`, `refresh_proof_nonce`), each with FORCE row-level security and one policy, nullable signature columns on `work_control`, and `action_signature.alg` (existing rows read `ed25519`); there is no data backfill. Rolling the app image back to 0.1.13 keeps schema 097: 0.1.13 does not read the new tables or columns, its writes satisfy the rewritten checks, and its migrate runner skips the six ledger rows it does not know.

### Added
- Server: the owner decides a work session's permission requests. A member host relays an ACP permission request as a `work_permission_request` row; `POST …/work-sessions/{session}/permission-decisions` lets the session owner pick allow-once or reject-once exactly once, and the decision travels to the host as a `permission` control in the same transaction. The host's closed preview of the request is stored with its SHA-256, served only to the owner at `GET …/permission-requests/{request}`, and only its hash is broadcast. (#3000, #3118, ADR-0188 D5)
- Web and desktop: the work tab's A pane shows ACP plan and tool-call cards and a permission card wired to the decision route. (#2779, #3013)
- Server: "Default AI" team rows. `GET/PUT /v1/provider/default-ai` (operator only) store which team link position and model id answer for team agents and for channel summaries; the row holds no key material and a personal subscription can never be a team row. "Check connection" now returns the provider's model ids. (#3009, ADR-0147 amendment 2026-09-28)
- Web and desktop: Settings › AI connections has a "Default AI" table by function, separating personal rows (kept on this device) from the operator's team rows (saved on the server), with a fallback sentence per row; a new local terminal session follows the personal default. (#2881, #3042, #3010)
- Server: a person's device signing keys (ADR-0146 amendment 2026-09-28, R2). `…/device-keys` registers, lists, endorses and revokes P-256 keys bound to the sign-in lineage; ending a lineage revokes its keys. Signed human instructions (`momo.human.control.v1`–`v3`) are verified with a one-time nonce and kept as provenance, and `…/device-keys/signing-context` gives clients the instance id. Requiring signatures stays off: `MOMO_HUMAN_CONTROL_SIGNATURE_REQUIRED` and `MOMO_HOST_REGISTER_SIGNATURE_REQUIRED` default to false, and without `MOMO_INSTANCE_ID` the signing context answers 503 `instance_id_unconfigured`. (#3021, #3022, #3023, #3027, #3068, #3097, #3118, #3119)
- Server: refresh tokens can be sender-constrained. A native client binds a separate refresh key to its lineage and proves it on each refresh; a proven re-presentation of a spent token recovers the lineage instead of logging out. `MOMO_REFRESH_PROOF_MODE` defaults to `observe`, where an unproven refresh behaves as before. (#3079)
- Web: a browser tab says an instruction or an allow needs the phone or desktop app, and signature errors read by reason. (#3029)

### Changed
- Security: re-presenting a spent refresh token more than 30 seconds after it was used ends the whole lineage for QR-linked (phone) sessions; password sign-ins keep the previous behavior unless `MOMO_REFRESH_REUSE_SWEEP_ALL_SESSIONS=true`. A re-presentation inside the grace window gets the same pair again. (#3022, #3074)
- Web: refresh-token rotation is coordinated across tabs and windows with a lock, a re-read and storage propagation, so a late tab no longer spends an earlier tab's token. (#3067)
- Server: a chain hop's stored key is bound to its origin — changing the origin without a new key is 409. Notification rules accept a partial `PATCH`. (#3040, #3012)
- Server: the provider egress guard moved into the `momo-egress` crate, and the worker's DNS precheck is bounded; the b26_1 usage summary window uses the database clock. (#2976, #2950)

### Fixed
- Server: one lock order for session rows, so linking a QR device no longer deadlocks against a lineage revocation. (#3107)
- Server image: the web stage copies the `docs/api` contract JSON (goldens and signing vectors) that web tests import, with a guard for any other out-of-tree import. (#3037, #3123)
- Web and desktop: open work surfaces keep a grace period when the host drops, the phone re-reads notification rules right before writing, and Settings screens were tidied. (#2893, #3064)

### Not in this release
- The server image carries the permission bridge, default AI rows, device-key and signed-instruction routes, refresh proofs (api) and the web bundle's permission cards, default AI table and browser guidance. The Secure Enclave keys, Touch ID/Face ID signing, the `momo-workd` root pinning and signature ratchet, refresh proofs from native clients and background refresh completion ship in desktop and iOS builds (#3025, #3026, #3028, #3063, #3076, #3078, #3084, #3088, #3098, #3103, #3106, #3117), not in the image. No desktop or iOS build is part of this release.
- Signature requirements are not switched on for `oort-team`; `MOMO_INSTANCE_ID` is not set there yet.
- runtime-unverified: signed instructions and permission decisions from a real phone or Mac against the team instance, a real refresh proof, and default AI rows answering through a real provider.

## [0.1.13] - 2026-09-27

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.13>. Tag target: `main=168ee323`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. No database migration since 0.1.12: the schema stays at 091 and upgrading swaps the images only, so rolling back to 0.1.12 needs no schema change.

### Added
- Server: "Check connection" calls the provider. `POST /v1/provider/link/test` sends one read-only GET per enabled hop (`/models`, or `/key` for OpenRouter) through the provider egress guard, and reports `ok`, `rejected`, `unreachable`, `rate_limited` or `unknown` with only the numbers the provider disclosed (model count, rate limits, OpenRouter credit). Response bodies and keys never leave the new `momo-provider-probe` crate. A checking operator gets 429 with `Retry-After` past six checks a minute, and a re-check of the same link within 20 seconds reuses the last result. (#2972, ADR-0147 amendment 2026-09-27)
- Server: agents can suggest the AI connection card. A hosted agent calls `oort_card_suggest` and a team agent calls `card_suggest`; the card is one message for the person who asked, with no approval, no run transition and no new table. New team agents get `card_suggest` in their profile by default, with a directive to suggest the card when someone asks to connect; an explicit tool list, including an empty one, is kept, and existing agents are unchanged. (#2959, #2985, ADR-0186 amendment 2026-09-27)
- Web and desktop: `/연결` in the composer and ⌘K "Open AI connection card" open a card at the end of the channel that only you see — subscription sign-in, the team key and a connection check. Text that looks like a key is not sent and not kept as a draft. An agent's suggested card renders for the person it is for; an operator sees one line with "View team connection", other members see one line. (#2957, #2961, #2977)
- Web and desktop: Settings › AI connections' team connection uses the same key form as the card, shows the result of "Save and check", and before "Disconnect" names the team agents that answer with that key. The check result gives a reason and what to do for each server reason, and a line of provider numbers. (#2971, #2984)
- Web and desktop: the work tab — "My work" (desktop) and "Team work" in the sidebar, the terminal grid across the whole route with a session list panel, and pane states (running, waiting for me, done) that reach the inbox and OS notifications. (#2927, #2951, #2958)
- Server, web and desktop: this Mac can be registered as a code-execution host from Settings; registering or revoking a host notifies the owner's devices in the same transaction. (#2954, ADR-0188)

### Changed
- `POST …/agents` without `enabledTools` now writes `["card_suggest"]` to the new agent's profile; OpenAPI `AgentProfileInput` requires only `instructions`. (#2985)

### Fixed
- Security: a subscription (owner-only) agent without a hosted connection row no longer runs on the team key — a mention, work request or welcome ends in the "the connection is down" line, and the worker refuses owner-only runs before calling a model. (#2940)
- Security: agent-to-agent calls refuse owner-only agents twice over, a turn without a key never calls a model, display names in refusal lines stay inert, and the server refuses creating a new provider link from `auth.json`. (#2922: #2897, #2900, #2911)
- Web and desktop: Settings › AI connections "My account · this Mac" shows the local CLI status, focus rings no longer appear after mouse use and a modifier key, and returning from the AI connection screen no longer loops. (#2953)

### Not in this release
- The server image carries the connection check, card suggestion tools, directive and default profile, owner-only isolation and host register/revoke notices (api, agent-worker), and the web bundle's connection card, suggested-card rendering, team connection settings and work tab. The desktop local git read (#2925) and `momo-workd` sidecar (#2954) ship in desktop builds, and the phone `/연결` card (#2987) in iOS builds, not in the image.
- LiveKit on the team instance (#2759): huddles still do not run on `oort-team`.
- runtime-unverified: a connection check against the real provider APIs (mock shapes only), a live agent runtime suggesting the card (mock-provider E2E only), TestFlight install.

## [0.1.12] - 2026-09-27

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.12>. Tag target: `main=6373ff48`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. Two database migrations since 0.1.11: `090_notification_rule_dnd_until.sql` adds nullable deadline and "value before do-not-disturb" columns to `notification_rule` and `member.presence_dnd_until` (existing rows stay NULL, so nothing changes until someone sets a deadline); `091_hosted_dm_approval.sql` adds `hosted_agent_connection.approved_dm_channel_ids` (default empty, under the table's existing FORCE RLS policy) and the `hosted_connection_channel_ids` function (SECURITY INVOKER, fixed search_path). Both are forward-only and additive; rolling the images back to 0.1.11 leaves them in place, and 0.1.11 can still clear do-not-disturb and notification pause because 090 has no deadline CHECK.

### Added
- Server: notification pause can carry a deadline, and do-not-disturb and notification pause move together — turning do-not-disturb on also pauses notifications in the same transaction, and turning it off restores what was there before. The deadline is compared when a push is decided, and the roster carries an active deadline (`dndUntilMs`). The deadline picker UI is a follow-up (#2899). (#2850, #2901, ADR-0124 amendment 2)
- Server: a hosted agent's 1:1 DM opens. The DM between an agent's owner and that agent opens automatically, but only on a connection the owner confirmed or consented to; another member's DM with the agent opens only when the owner approves that DM. A subscription agent answers only its owner's DM, and group DMs stay closed. If an admin who is not the owner confirms the connection, its DMs close and the other-member approvals are cleared. (#2915, ADR-0162 amendment 2)
- Web and desktop: Settings › agent credentials lists the agent's 1:1 conversations — the owner's is always open, only the owner can open or close another member's (with one more confirmation), and admins see it read-only. (#2915)
- Web, desktop and phone: the DM composer hint follows the server's delivery state; "talk to it directly" appears only in a DM that is open to the agent. (#2915, #2891)

### Not in this release
- The server image carries the do-not-disturb deadline and bundle (api, notifier, migration 090), hosted 1:1 DM delivery and approval (api, agent-worker, migration 091) and the web bundle's 1:1 conversation list and DM hint. The phone hint ships in iOS builds, not in the image.
- Personal-subscription isolation hardening, inert display names in more refusal lines and refusing new `auth.json` provider links on the server (#2922: #2897, #2900, #2911) landed after the build commit and ship in a later release.
- The do-not-disturb deadline picker (#2899) and LiveKit on the team instance (#2759): huddles still do not run on `oort-team`.
- runtime-unverified: an owner-approved hosted DM against a live agent runtime on a team instance, a do-not-disturb deadline expiring on a real phone push, TestFlight install.

## [0.1.11] - 2026-09-27

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.11>. Tag target: `main=21aead09`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. No database migration since 0.1.10: the schema stays at 089 and upgrading swaps the images only.

### Added
- Server: provider links speak the Anthropic Messages wire, so a Claude API key can run a team agent. Presets for OpenAI, Anthropic, xAI (Grok) and OpenRouter; keys are scrubbed from errors, logs and debug output. (#2872, ADR-0147, ADR-0004)
- Server: when a hosted agent cannot answer — hosted delivery off, link disconnected, channel not approved, or a 1:1 DM — the person who called it gets one line with the reason and the way to fix it (10-minute cooldown). An agent's display name can no longer inject a markdown link. (#2871)
- Web and desktop: Settings › AI connections is reorganised into "My account · this Mac" and "Team connections · this server", with a side panel; pasting an `auth.json` no longer creates a new connection. AI connections can be reopened from settings and the agent screen, and subscription agents are on by default in builds. (#2877, #2870)
- Desktop: Claude Code and Codex sign in through a modal that runs the official CLI in a hidden PTY. (#2816)
- Phone: the profile shows presence, a status message and notification pause. (#2848)

### Changed
- Security: provider egress refuses private, loopback, link-local and metadata targets even over https — when a link is saved, and again at connect time against the resolved addresses (DNS rebinding) — and does not follow redirects. The OAuth token refresh path goes through the same guard. A deployment that used a private-range https host as a provider must set `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1` and list the host in `AGENT_PROVIDER_LOCAL_HOSTS`; the guarded client ignores `HTTP(S)_PROXY`. (#2852, #2894)
- Web: the work surface opens only while a host is online. (#2780)
- Web and phone: notification pause wording is the same everywhere. (#2848)
- Desktop: the terminal defaults to a dark theme. (#2849)
- Server: a test pins that the team agent path never reaches a person's own subscription credentials. (#2882)

### Not in this release
- The server image carries the Anthropic wire and presets, the provider egress guard and the "why the agent did not answer" notice (api, agent-worker), and the web bundle's AI connections settings and work-surface gate. The CLI sign-in modal and terminal theme ship in desktop builds and the phone profile in iOS builds, not in the image.
- Do-not-disturb deadlines and the notification pause bundle (#2850, migration 090) landed after the build commit and ship in a later release.
- Approving a hosted agent in a 1:1 DM (#2915) is in progress.
- LiveKit on the team instance (#2759): huddles still do not run on `oort-team`.
- runtime-unverified: an Anthropic-wire team agent against the live API on a team instance, the CLI sign-in modal in a signed DMG, TestFlight install.

## [0.1.10] - 2026-09-26

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.10>. Tag target: `main=824b909e`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. One database migration since 0.1.9: `089_agent_invocation_scope.sql` adds `agent.invocation_scope` (default `workspace`, so every existing agent keeps its behaviour) and `agent.subscription_harness`, their CHECK constraints, and a trigger that refuses to reopen an owner-only agent. It is forward-only; rolling the images back to 0.1.9 leaves the added columns in place.

### Added
- Server: an agent that joins through a personal subscription (Claude Code or Codex on the owner's Mac) answers only its owner. The server enforces it on every delivery path; anyone else, or the owner while their Mac is offline, gets one short notice from the agent. `MOMO_SUBSCRIPTION_AGENTS_ENABLED=false` turns the subscription path off (unset means on). (#2830, ADR-0193)
- Huddles: the notifier sweeps ghost participants by comparing each active huddle with the LiveKit room. It runs only when LiveKit is configured and `MOMO_HUDDLE_SWEEP_DATABASE_URL` points at the RLS-bound app role. (#2802)
- Web and desktop: onboarding 2.0 — the Kometto guide and progress dots, one welcome step, sign-in and invite acceptance on one screen each, the claim screen on the new frame, 「Whose AI should think?」 AI connection, and a first-conversation band with the phone-link card in the channel instead of a full-screen step. (#2828, #2831, #2832, #2835, #2836, #2829)
- Web and desktop: design system 2.0 — dawn-sky tokens from one core source with a contrast test over every combination, filled pills, round icons, cards and glass, and the desktop shell's gradient floor with a floating content pane. (#2735, #2738, #2740)
- Desktop: a local terminal — split-grid layout per session, xterm panes over a Tauri PTY, the ⌃` dock and a shortcut table; local harness detection for `claude` and `codex`. (#2801, #2824, #2838, #2827)
- Phone: the design system 2.0 shell, home and conversation screens, with a centred pill tab bar and a light + menu. (#2739, #2742, #2800, #2825)

### Changed
- Brand: the C2-04 Bubble mark is the canonical SVG on web, desktop and phone (#2731), and the app icon is the I4 front close-up of Kometto on iOS, macOS Dock and the web app. (#2733, #2797)
- Phone: the welcome screen is split from the sign-in form, and the notification permission is asked only after a one-button explanation. (#2833)

### Fixed
- Huddles: a connected huddle is no longer cut off when its join token's lifetime ends. (#2798)
- Web: the header menu's Escape handling no longer races, and the shell, channel-header and composer gates run again. (#2746)
- Web: the terminal dock folds away where the work surface does not apply, with surface-neutral copy and an explained empty state. (#2795)
- Desktop: huddles ask for the microphone in the signed DMG (usage description and audio-input entitlement). (#2804)
- Phone: realtime waits a grace period before showing "reconnecting", reconnects at once on foreground, and replaces an expired token before connecting. (#2755)

### Not in this release
- The server image carries the owner-only invocation (api and migration 089), the huddle ghost sweep (notifier) and the web bundle (onboarding 2.0, design system 2.0, terminal dock). The phone entries ship in iOS builds and the desktop shell (PTY, harness detection, microphone entitlement) in desktop builds, not in the image.
- LiveKit on the team instance (#2759): huddles still do not run on `oort-team`, so the ghost sweep stays off there.
- runtime-unverified: owner-only invocation against a real subscription agent on a team instance, the ghost sweep against a live LiveKit room, TestFlight install.

## [0.1.9] - 2026-09-26

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.9>. Tag target: `main=eb09f568`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. One database migration since 0.1.8: `088_push_session_lineage.sql` adds two nullable columns and one partial index, and invalidates every live push registration made before it (a phone that is still signed in registers again on its next launch). It is forward-only; rolling the images back to 0.1.8 leaves the added columns in place.

### Added
- Web and desktop: attachments show an image thumbnail in the send tray before sending, images in the timeline open in a lightbox, and a PDF opens in a new window on web and in the default app on desktop. (#2710)
- Phone: the top avatar opens a profile sheet with theme, notifications and sign-out; the block at the bottom of the screen is gone. (#2722)

### Fixed
- Push: signing out or revoking a session invalidates that device's push registration, so a signed-out phone no longer receives the next person's alerts or badge count. The server ties each registration to its sign-in session (migration 088). (#2685)
- Phone: signing out deletes this phone's push registration and cannot race a token refresh. (#2692)
- Desktop: the window's traffic-light buttons and the panel collapse button sit on the same line. (#2708)
- Phone: on the connect screen the focused field and the sign-in button stay above the keyboard. (#2694)
- Phone: following a conversation settles at the end even after a long new row or rows not yet measured. (#2697)

### Not in this release
- The server image carries the push-registration lineage (api and migration 088) and the web bundle's attachment previews and desktop title-bar alignment. The phone entries ship in iOS builds and the desktop shell in desktop builds, not in the image.
- The C2-04 brand mark (#2731) and design system 2.0 (ADR-0189, #2721) landed after the build commit and ship in a later release.
- runtime-unverified: real-device push after sign-out and re-registration on the next phone launch, TestFlight install.

## [0.1.8] - 2026-09-25

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.8>. Tag target: `main=088da65b`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. No database migration since 0.1.7: upgrading swaps the images only.

### Added
- Push notifications play the default sound for messages, mentions, approvals and work alerts. (#2672)
- Desktop: the top of the window drags the window, and files can be dropped into the app. (#2674)

### Fixed
- Phone: a long conversation no longer leaves the whole list blank. (#2654)
- Phone: opening a team room settles at the end instead of stopping short. (#2680)
- Phone: push-tap landing — a message is only called missing after the tail is re-read, and one already held lands at once. (#2645)
- Phone: the first subscription backfill starts after the head page instead of reading the room's whole history (a 3,000-row room: 62 reads → 2). (#2649)
- Phone: the launch screen shows only the boot background, without template text. (#2673)
- Phone: the app badge follows the unread total and clears with it. (#2675)
- Desktop: the OS notification permission check no longer errors — the capability grants the notification commands it needs. (#2683)

### Not in this release
- The server image carries the push sound (push-relay) and the web bundle's desktop drop guard. The phone entries ship in iOS builds and the desktop entries in desktop builds, not in the image.
- Dropping a device's push registration on logout or session revoke (#2685, #2692) landed after the build commit and ships in the next release.
- runtime-unverified: real-device APNs sound and badge, TestFlight install (M7-I evidence build).

## [0.1.7] - 2026-09-24

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.7>. Tag target: `main=1dd9ceea`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images. No database migration since 0.1.6: upgrading swaps the images only.

### Added
- Phone: approve or reject an approval card right in the timeline, and a result card after the decision; a one-time invite link is shown once and never stored. (#2585)
- Phone: unread badge and divider follow the same computed state as web; opening a conversation clears a desktop "mark unread" only after it has been drawn. (#2593)
- Phone: "jump to unread" and "jump to latest" pills with web copy, VoiceOver focus on landing, and a scroll machine that settles on movement instead of a clock. (#2594, #2614, #2622)
- Phone: tapping a push notification opens the message, thread reply or approval it points to and lands on it — also after a cold start or from the background; when that conversation is already open, the tail is re-read first so the screen never says a message is missing before it has arrived. (#2584)
- Railway team-instance template (T2): nine-service catalog, start commands that drop root, sealed APNs key handling, Centrifugo literals pinned to `infra/centrifugo.json`, a client-IP measurement gate before any claim link or invite is shared, and the local-storage upload route (`/__momo_stub/*`) on the Railway edge. (#2580, #2606)
- `momo-workd` skeleton for ADR-0188 remote work: dial-out registration, signed v2 heartbeat, control polling, ACP sessions under D6 isolation (not distributed yet). (#2579)
- Phone browser onboarding: inputs no longer trigger iOS focus zoom (16px floor on touch and narrow screens), no sideways drag during step transitions, and "지금은 건너뛰기" sits at the top of the agent step. (#2620)
- iOS TestFlight preparation: privacy usage strings, export-compliance flag, build-number scheme, a release archive script that refuses non-`main` commits, and the TestFlight runbook. (#2587)

### Fixed
- Self-hosted public origin (T1): attachment uploads work — the edge now routes `/__momo_stub/*` to the api (it answered 405 before), and every edge Caddyfile is checked for the same route. (#2625)
- iOS: the app ships an app icon — App Store Connect refused the first TestFlight upload without one, and the post-build check now fails an exported app that lacks it. The single opaque 1024 px icon is a placeholder until store submission. (#2646)

### Security
- Local-storage upload URLs are one-time and expire after an hour; a published attachment can no longer be overwritten by replaying its upload URL. (#2624)
- Local-storage upload PUT (`/__momo_stub/drive/uploads/{token}`): the token, session, size and type are judged before the body is read, and the body streams to disk — four concurrent anonymous 100 MiB PUTs now move server memory by +0.4 MiB instead of +1.2 GiB. A per-IP limit, `RATE_LIMIT_DRIVE_UPLOAD_PER_IP` (default 120 per minute), counts only refused capabilities, so a live upload URL is never throttled; an address over budget gets 429 on this route. A chunked body that runs past the declared size is now 400 (it used to be buffered up to 100 MiB, then 413). On boot the api clears unfinished upload sessions and partial files, so restoring a drive-volume snapshot cannot revive a live upload URL. (#2631)
- ADR-0188 R0: remote-host defences — the host owner decides, agents may only kill on member hosts, remote auto-approve and remote shell are refused, heartbeat v2. (#2576)
- ADR-0188 R0.1 + (A′): non-admins cannot register workspace-scoped hosts, app hosts are member-scoped only, member hosts receive only the owner's non-shell controls and everyone's kill, and agent-originated non-kill controls to member hosts are refused at decision, tool-request and executor time. (#2597)
- ADR-0188 R1.1: `momo-workd` hardening — credential redaction in outgoing events, Claude reads fenced to the working folder, owner-only spawn on member hosts, request-recorder proof that the host key never leaves the machine. (#2605)
- ADR-0188 R1.2: remote Codex runs sandboxed in a host-owned home — it never reads the owner's `~/.codex`, starts with no MCP servers and with 13 out-of-sandbox features turned off, and needs a one-time `codex login` into that home. A Claude session that does not start in the fixed permission mode is corrected before its first prompt, and refused if the agent does not confirm it. (#2621)
- ADR-0188 R1.3: remote agents receive only an allowlist of host environment variables (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `TMPDIR`, `LANG`, `LC_*`), so API keys, proxy and CA settings in the host environment no longer reach them and they run on their logins only; remote Codex commands skip the owner's zsh start-up files, and the Codex process runs with a host-owned `HOME`, so the owner's skills layer is not loaded. (#2644)

### Not in this release
- The server image carries the server and web entries above. The phone entries ship in iOS builds, not in the image. `momo-workd` is in the source tree but not distributed, and remote work is not opened to the phone yet (rest of ADR-0188 R1; R1.4 is #2647).
- runtime-unverified: real-device APNs, TestFlight install and push-tap landing on a device (M7-I evidence build in progress).
- Known phone defects: a long first page with thread or approval rows can leave the list blank (#2586, fix in review in #2654), and a message sent from far up a long conversation can land out of view (#2658).

## [0.1.6] - 2026-09-23

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.6>. Tag target: `main=ab58a111`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`; SLSA v1 provenance verified for the app and postgres images.

### Added
- Agent workspace actions (ADR-0186): the agent proposes, a human approves, the server executes. Agent Port tool `oort_action_propose`, `GET /v1/workspaces/{ws}/actions`, v1 action `invite.create` (admin approval); the one-time invite link travels only in the decision response, with `Cache-Control: no-store`. (#2508, #2509)
- Web: command registry and ⌘K command groups (#2524); action card catalog v1 — action row, `action_result`, one-time link (#2540).
- Linked devices list and revoke: `GET/DELETE /v1/auth/devices` (ADR-0180 D5) and web settings › 기기. (#2468, #2490)

### Changed
- Webhook master keys are split from `JWT_HMAC`: `WEBHOOK_INGRESS_MASTER_KEY` and `OUTBOUND_WEBHOOK_MASTER_KEY`, with an audit on the ingress budget (ADR-0004 amendment 4). **Upgrading:** both keys must be in the env or webhook-sender refuses to boot; run the generator with the current `JWT_HMAC` exported and it copies that value into both keys, so issued webhook and doorbell secrets survive. (#2523)
- Overlay layer order (scrim, surface, transient confirmation). (#2485)

### Security
- Refresh and revoke of a linked device are serialized. (#2537)
- PostgreSQL image: libssh2 `1.11.1-1+deb13u2` (CVE-2026-66032, CVE-2026-66033, CVE-2026-66034, CVE-2026-66035, CVE-2026-58050, CVE-2026-58051); package URLs moved to the permanent archives (snapshot.debian.org, apt-archive.postgresql.org). (#2573)

### Docs
- Goal A (ADR-0187): deploy gate grades M7-I/M7-S, bundle promotion, `STATUS.md` frozen. (#2566)
- Phone remote work design ADR-0188 Accepted. (#2575)

### Not in this release
- ADR-0188 R0 (remote-host defence, #2576) is on `track/engine`, not in this image.
- runtime-unverified: published-image E2E re-measure, the Railway team instance deploy and real-device APNs (#2205).
- The phone's empty list on long conversations (#2586) is a client defect outside this release.

## [0.1.5] - 2026-09-11

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.5>. Tag target: `main=803ae7d5`. Multi-arch (linux/amd64 + linux/arm64), digest pins in `releases/latest.json`.

### Added
- First-class claim mode in the generator: `scripts/self_host_env.sh --claim` writes `MOMO_BOOTSTRAP_CLAIM=1` instead of the owner password key (1:1 key swap, canonical 43 / T2 44), `--compose` brings up a claim env (ADR-0166 exclusion keeps refusing both keys), doctor accepts the claim fixture; the awk surgery is retired from the docs. (#2438)
- `momo_notifier` runtime DB role (LOGIN NOSUPERUSER BYPASSRLS) with table-scoped least-privilege GRANTs derived from the notifier call graph incl. INVOKER trigger reads, notifier URL switched off the owner URL, `oort doctor` role/DELETE/allowlist check, static grant guard (`test_notifier_role_grants.sh`), and automatic env backfill of the two new keys on `oort upgrade` / generator re-run for existing installs. (#2193, #2448)
- Zero-base onboarding (ADR-0185): after the claim password, S1 「내 워크스페이스·내 이름」 (workspace name · display name · handle, 1/2) → S2 「팀원 초대」 (invite link, skip escape hatch, 2/2) → first-run (kickoff-hold → 「첫 에이전트 연결」 → phone link). The seeded 「데모 사용자」/`momo Demo Workspace` labels no longer surface; settings › 워크스페이스 (rename) and settings › 프로필 (handle) are the re-entry doors. (#2301, #2331, #2332, #2333, #2334, #2335, #2356, #2336)
- Engine write paths: `PATCH /v1/workspaces/{ws}` (rename, `updatedAtMs` 409) and `PATCH /v1/workspaces/{ws}/members/me` `handle` (409 taken / 403 banned, `member.renamed` fan-out, past message bodies untouched). (#2331)
- Welcome kickoff on first agent activation (native create or hosted Agent Port `active`), delivered over the gateway rail for hosted agents; with 0 agents the client goes straight to 「첫 에이전트 연결」. (ADR-0181 D2/D3 amendment, #2334, #2335)
- Platform-neutral self-hosting (ADR-0184): `scripts/self_host_env.sh --platform <name>` profiles (railway = `--railway` alias, fly, aws-lightsail, gcp-vm, host-network), `MOMO_SELF_HOST_PLATFORM` stamp, `docs/SELF_HOST_AGENT.md` §0 agent boundary + §1 tier table. (#2296, #2328, #2340)
- Day-2 contract v2 for managed platforms (T2): `oort backup/restore` over `MIGRATE_DATABASE_URL`, `oort doctor --tier t2` (SQL-over-URL `stack.*`, `/healthz` `schema{applied,head}`), `oort upgrade` = platform redeploy; runtime image ships PGDG `postgresql-client-18` + python3 so day-2 runs in-image. (#2325, #2346, #2347)
- Provisioning recipes: Fly.io T1 (`infra/fly`), AWS Lightsail/EC2 T1 (`infra/aws`, Terraform + cloud-init + least-privilege IAM + budget guard), Cloudflare T3 edge (`infra/cloudflare`, DNS · Tunnel · TLS, not compute), each with a static contract test. (#2379, #2377, #2386)
- Agent credentials settings screen (SH-6a-w), Slack-compatible webhook inbound `/hooks/*` via every public edge (#1265), Agent Port join + doorbell/sweep playbook for hosted agents, Grok Bot CDP harness (`scripts/dev/grokbot_cdp`). (#2204, #2225, #2230, #2231)
- `gate:csp-deploy` evaluates rendered Caddyfiles (docker/caddy); Railway template contract wired into the docs profile; env-template table covers platform recipe dirs. (#2297)
- Committed release manifest `releases/latest.json` with generate/drift scripts.

### Changed
- Gate policy: `local_gate.sh --profile docs` now runs `check_release_manifest.sh`, the oort day-2/doctor harnesses (per-file `bash -n` + shellcheck, fail-closed syntax loop), and the PITR contract test; `GATED_DOCS` covers the SELF_HOST family en/ko (11 → 16 documents); hardening locks anchor uncommented lines inside the docs arm. (#1984, #2124, #2456)
- Self-host generated env defaults `MOMO_HOSTED_DELIVERY_ENABLED=true` (D9); `--local-build` upgrade rebuilds instead of pulling (D10); `MOMO_BUILD_SHA` stamped into the web bundle (D2). (#2261, #2269, #2277)
- `oort doctor` outbox verdict carries info/age; T2 origin picker skips loopback/tauri origins. (#2270, #2347)
- Hosted wizard blank-name fallbacks: fact row shows the handle, one missing-name constant, regenerate launch seeds the raw name. (#2327)
- `hostedRoutineLabel` with an empty handle uses a shortened member id segment (ADR-0162 D6 amendment). (#2395)
- Worker lane: Grok Build CLI grok-4.6 (Cursor CLI fallback) — `docs/planning/PIPELINE.md`. (#2357)

### Fixed
- `test_pgbackrest_pitr_contract.sh` was red on Colima because the fixture lived under macOS `TMPDIR` (not bind-mountable); fixture moved under the worktree, attach diagnostics surfaced. (#2157)
- Claim success now records the four first-run markers so kickoff-hold → first-agent → phone-link runs after self-host claim. (#2301)
- S2/S1 onboarding: session-restore hold ordering after claim, first-run markers written before optional stages, reload re-entry, product-Korean error copy with next steps, long-name wrapping in the stale-name banner. (#2333, #2332)
- Hosted-agent opener no longer lands in an undeliverable outbox row (gateway rail + advisory lock). (#2334)
- Wizard step-4 approval sentence with an empty agent name (bare particle). (#2327)

### Docs
- Zero-base E2E-B deviations D1–D4: single claim-mode install path, `--compose` claim behaviour, gateway address rule (loopback http accepted, non-loopback http = plaintextRemote) with the local-mock recipe, skip disappears after issuing an invite. (#2429)
- Second measured zero-base run (`docs/planning/research/2026-09-10-e2e-zero-base-run.md`, 11/11 PASS on db5cb8e9); this release's images were re-measured from the published digests before tagging.
- `docs/SELF_HOST_FIRST_DAY(.ko).md` rewritten for the zero-base first run; ADR-0166 §6 and ADR-0181 D2/D3 amendment sections; UX bible P5 annotation. (#2336)
- `docs/SELF_HOST_AGENT.md` §3.3 Grok Bot VM corrections from the measured E2E-A run (Docker preflight/fallbacks, doorbell human approval point, sweep delay copy, HAP-E6 acknowledge evidence). (#2326)
- Research: E2E-A/E2E-B measured runs (`docs/planning/research/2026-09-09-e2e-{a,b}-*.md`), platform-neutral inventory, ADR-0184/0185.

## [0.1.4] - 2026-09-02

GitHub Release: <https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.4>. Tag target: `main=e39e9427`. Multi-arch (linux/amd64 + linux/arm64) manifest lists, SLSA v1 provenance verified. Source notes: [`docs/planning/research/2026-09-02-v0-1-4-release-notes.md`](docs/planning/research/2026-09-02-v0-1-4-release-notes.md).

### Added
- Message reminders REST CRUD + web UI (ADR-0175); custom member status on presence + settings UI (ADR-0176).
- Member-owned sidebar sections (`member_sidebar_prefs`), star/sort/drag-and-drop, row context menu (ADR-0177).
- Search channel scope (`channel=` + sealed cursor) and scope chips; unified `@`/`#`/`:` composer autocomplete.
- Mark-unread signal (`marked_unread_before_seq` + `read_intent`) with a single momo-core composition point and 「여기부터 안 읽음」 (ADR-0178).
- Appearance accent system (Dawn default + 4 curated accents, ADR-0174); onboarding S0 Oort landing + step shell (BZ-6a).
- buzz-parity wave: reaction name tooltips, top unread jump pill, huddle mic device picker + gain, notification permission/kind toggles, cross-channel drafts panel, composer format tray, link preview rich/compact/off, channel intro block, settings page + profile display name, sidebar collapse, channel header rework.
- Roster role change from member profile; profile menu logout with confirmation; self display-name rename; agent-target role change rejection.
- Self-host huddle `MOMO_LIVEKIT_NODE_IP` knob (generated env default 127.0.0.1).

### Changed
- Governance/docs: ADR-0179~0182 accepted (motion/press/elevation/density axes, QR device link, welcome kickoff, ephemeral confirmation policy); `docs/planning/PIPELINE.md` single lane/model canon; `AGENTS.md` merged into `AGENTS.md`; canonical docs rotation.

### Known
- UnreadPill return-visit arming is non-deterministic (pre-existing, #1966); phone does not consume mark-unread yet (#1964).

## [0.1.0] - 2026-08-21

First published `v0.x` of the self-hosted messenger. GitHub Release:
<https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.0>.
Tag target: `main=45a154d2`. Source notes (no invented measurements):
[`docs/planning/research/2026-08-21-v0-1-0-release-notes.md`](docs/planning/research/2026-08-21-v0-1-0-release-notes.md).
Ledger: GitHub issue #1332 comment, 2026-08-21.

This GitHub Release records **server/image** artifacts. It does not publish a
desktop updater payload.

### Added

- Channels, threads, quotes, typing, pins, search — on web, desktop (Tauri),
  and mobile (React Native).
- Agents as members: mention an agent, watch its run stream into the channel,
  stop it mid-flight.
- Human approvals in-channel and from the lock screen — fail-closed when locked.
- Run outcomes, usage/cost ledger, and audit events inside the conversation.
- Attachments v0: browser uploads go directly to the operator's Drive backend —
  bytes never transit the oort server.
- Work observation: watch an agent's terminal session live from the desktop app.
- A measured self-host path: clone → env script → compose up → logged in
  ([`docs/SELF_HOST.md`](docs/SELF_HOST.md)).
- Published `linux/amd64` images, pinned by digest, with SLSA v1 provenance
  (attestation verify PASS — ledger #1332 comment 2026-08-21).
- A design system (「Oort cloud」) whose contrast and spacing rules are
  enforced by tests and gates, in light and dark.
- Security headers (CSP · HSTS · nosniff · referrer policy) on the reference
  deployment.

| subject | immutable image |
|---|---|
| application | `ghcr.io/yeomyeonggeori/oort@sha256:0fbddd36947b4dfd18d6fc91e9229fc5e6f52ebb896b9bf632a2ec127620b8eb` |
| PostgreSQL 18 + pgBackRest | `ghcr.io/yeomyeonggeori/oort-postgres@sha256:c68063695bde97bb2911d5eca4ebce6a94858dc9af9f60ad294657ef7cea0757` |

Self-host digest pull (`scripts/self_host_env.sh --published-image`) consumes
**only the application row**. The PostgreSQL image is for the production / PITR
path. Pin `@sha256:`. Do not use `latest` or `sha-<commit>`.

Honesty-table items still in flight at this tag (not a schedule): webhook and
event-subscription **delivery** (settings surfaces shipped; Rust delivery worker
in flight); agent run-history reads (writes land; views wait on three routes);
retiring the original Swift codebase. `linux/arm64` images are **not** in this
release. Apple Silicon native pull is not supported (measured 2026-08-21). On
ARM hosts use the local-build path in
[`docs/SELF_HOST.md`](docs/SELF_HOST.md) §2-A, or wait for a later arm64
release.

[Unreleased]: https://github.com/yeomyeonggeori/oort/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.0
