-- =============================================================================
-- 149_official_catalog_display_fields.sql - #4313, ADR-0113 add. 3 F1
--
-- The seven official apps get their catalogue display fields (owner 2026-10-24:
-- 「플러그인에 들어가면 저런 좋은 UI와 실제 해당 플러그인과 관련된 로고도 표시」):
--
--   plugin.logoKey         name of a client-bundled logo asset (never a URL; clients fall back to the
--                          text tile when they do not know the key)
--   plugin.category        one of communication / productivity / developer / files / project
--   plugin.websiteURL      HTTPS link (the oort-hosted team drive has none)
--   plugin.starterPrompts  0~3 `{text, tool}` example sentences. Korean 해요체, and only things the
--                          app can really do: every `tool` is a read (R) or approval-required write (A)
--                          tool of the same manifest (Gmail has no send: draft and label only).
--
-- A jsonb patch, not a re-seed: the tools, schemas, policy and version of each manifest are
-- untouched (143's tools are measured vendor output; `capability_version` and every capability
-- projection key on `version`, so no version bump and no projection rebuild). The manifest AND its
-- digest are rewritten in one statement with the expression the runtime and 013/143 use, so
-- `manifest_digest` always matches `manifest::text` (a stale digest drops the app from the catalogue,
-- `routes/plugins.rs`).
--
-- **An older server refuses these manifests** (its validator has an exact `plugin` key set), the
-- apps then vanish from its catalogue and installs/grants answer 409. Roll the server image back
-- only AFTER the rollback SQL at the bottom of this file has run (keep it in the PR description).
--
-- Idempotent: the UPDATE fires only where the patched manifest differs; the DO block at the end
-- fails the migration loudly if one of the seven rows is missing (a seed that silently stays
-- un-patched would ship an app without its logo and examples).
-- RLS: `plugin_registry` is global (013) and carries no tenant column; no table, policy or grant
-- changes here. `schema_v0.sql` untouched.
-- The server fixtures `server/Fixtures/plugin-manifests/*.json` equal 143 (or 015 for the team
-- drive) + this patch; a unit test (`migration_149_display_patch_turns_the_seeds_into_the_fixtures`)
-- holds the three together.
-- =============================================================================

WITH display(plugin_id, patch) AS (
  VALUES
  (
    'com.momo.plugins.drive',
    $display$
    {
      "logoKey": "google-drive",
      "category": "files",
      "starterPrompts": [
        {
          "text": "공유 드라이브에서 이번 분기 기획 문서를 찾아 줘요.",
          "tool": "drive.search_files"
        },
        {
          "text": "공유 드라이브 파일이 마지막으로 바뀐 때를 알려 줘요.",
          "tool": "drive.get_file_metadata"
        },
        {
          "text": "공유 드라이브 문서를 텍스트로 읽고 핵심만 정리해 줘요.",
          "tool": "drive.export_text"
        }
      ]
    }
    $display$::jsonb
  ),
  (
    'com.momo.plugins.github',
    $display$
    {
      "logoKey": "github",
      "category": "developer",
      "websiteURL": "https://github.com",
      "starterPrompts": [
        {
          "text": "내가 올린 풀 리퀘스트 중 아직 열려 있는 것을 찾아 줘요.",
          "tool": "github.search_pull_requests"
        },
        {
          "text": "저장소의 열린 이슈를 최근에 바뀐 순서로 정리해 줘요.",
          "tool": "github.list_issues"
        },
        {
          "text": "저장소의 최신 릴리스에 어떤 변경이 담겼는지 알려 줘요.",
          "tool": "github.get_latest_release"
        }
      ]
    }
    $display$::jsonb
  ),
  (
    'com.momo.plugins.gmail',
    $display$
    {
      "logoKey": "gmail",
      "category": "communication",
      "websiteURL": "https://mail.google.com",
      "starterPrompts": [
        {
          "text": "받은편지함에서 이번 주에 온 메일을 찾아서 요약해 줘요.",
          "tool": "gmail.search_threads"
        },
        {
          "text": "방금 이야기한 내용으로 팀에 보낼 메일 초안을 만들어 줘요. 보내기는 제가 직접 할게요.",
          "tool": "gmail.create_draft"
        },
        {
          "text": "내 Gmail 라벨 목록을 보여 줘요.",
          "tool": "gmail.list_labels"
        }
      ]
    }
    $display$::jsonb
  ),
  (
    'com.momo.plugins.google-calendar',
    $display$
    {
      "logoKey": "google-calendar",
      "category": "productivity",
      "websiteURL": "https://calendar.google.com",
      "starterPrompts": [
        {
          "text": "오늘 일정을 시간 순서대로 알려 줘요.",
          "tool": "google-calendar.list_events"
        },
        {
          "text": "이번 주에 팀원들이 모두 비는 시간을 찾아 줘요.",
          "tool": "google-calendar.suggest_time"
        },
        {
          "text": "다음 주에 잡힌 회의를 찾아서 정리해 줘요.",
          "tool": "google-calendar.search_events"
        }
      ]
    }
    $display$::jsonb
  ),
  (
    'com.momo.plugins.google-drive',
    $display$
    {
      "logoKey": "google-drive",
      "category": "files",
      "websiteURL": "https://drive.google.com",
      "starterPrompts": [
        {
          "text": "내 드라이브에서 지난달에 만든 문서를 찾아 줘요.",
          "tool": "google-drive.search_files"
        },
        {
          "text": "최근에 연 파일을 목록으로 보여 줘요.",
          "tool": "google-drive.list_recent_files"
        },
        {
          "text": "찾은 문서를 읽고 핵심만 세 줄로 요약해 줘요.",
          "tool": "google-drive.read_file_content"
        }
      ]
    }
    $display$::jsonb
  ),
  (
    'com.momo.plugins.linear',
    $display$
    {
      "logoKey": "linear",
      "category": "project",
      "websiteURL": "https://linear.app",
      "starterPrompts": [
        {
          "text": "나에게 배정된 Linear 이슈를 우선순위 순서로 보여 줘요.",
          "tool": "linear.list_issues"
        },
        {
          "text": "진행 중인 프로젝트를 한눈에 정리해 줘요.",
          "tool": "linear.list_projects"
        },
        {
          "text": "내 Linear 알림을 최근 순서로 보여 줘요.",
          "tool": "linear.get_notifications"
        }
      ]
    }
    $display$::jsonb
  ),
  (
    'com.momo.plugins.notion',
    $display$
    {
      "logoKey": "notion",
      "category": "productivity",
      "websiteURL": "https://www.notion.com",
      "starterPrompts": [
        {
          "text": "Notion에서 지난주 회의록을 찾아 줘요.",
          "tool": "notion.notion-search"
        },
        {
          "text": "최근에 열어 본 Notion 페이지를 목록으로 보여 줘요.",
          "tool": "notion.notion-list-recent-pages"
        },
        {
          "text": "오늘 회의 내용을 새 Notion 페이지로 정리해 줘요.",
          "tool": "notion.notion-create-pages"
        }
      ]
    }
    $display$::jsonb
  )
),
patched AS (
  SELECT r.plugin_id,
         jsonb_set(r.manifest, '{plugin}', (r.manifest -> 'plugin') || d.patch) AS manifest
    FROM plugin_registry r
    JOIN display d ON d.plugin_id = r.plugin_id
)
UPDATE plugin_registry r
   SET manifest = p.manifest,
       manifest_digest = 'sha256:' || encode(sha256(convert_to(p.manifest::text, 'UTF8')), 'hex'),
       updated_at = now()
  FROM patched p
 WHERE r.plugin_id = p.plugin_id
   AND r.manifest IS DISTINCT FROM p.manifest;

DO $$
DECLARE
  patched integer;
BEGIN
  SELECT count(*) INTO patched
    FROM plugin_registry
   WHERE plugin_id IN (
    'com.momo.plugins.drive',
    'com.momo.plugins.github',
    'com.momo.plugins.gmail',
    'com.momo.plugins.google-calendar',
    'com.momo.plugins.google-drive',
    'com.momo.plugins.linear',
    'com.momo.plugins.notion'
   )
     AND manifest #> '{plugin,logoKey}' IS NOT NULL
     AND manifest #> '{plugin,category}' IS NOT NULL
     AND manifest #> '{plugin,starterPrompts}' IS NOT NULL
     AND manifest_digest = 'sha256:' || encode(sha256(convert_to(manifest::text, 'UTF8')), 'hex');
  IF patched <> 7 THEN
    RAISE EXCEPTION '149: expected 7 official manifests with display fields and a matching digest, found %', patched;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- ROLLBACK (manual; run BEFORE rolling the server image back to a build older than #4313).
-- Removes exactly the four keys this migration added and re-derives the digest, which restores
-- the pre-149 manifest and digest byte for byte (jsonb text is canonical). The ledger row of this
-- file stays, so the next boot does NOT re-apply 149: to roll forward again later, run this file
-- once more (it is idempotent) or delete its ledger row before that boot
-- (`DELETE FROM schema_migrations WHERE version = '149_official_catalog_display_fields.sql'`).
--
--   UPDATE plugin_registry r
--      SET manifest = s.manifest,
--          manifest_digest = 'sha256:' || encode(sha256(convert_to(s.manifest::text, 'UTF8')), 'hex'),
--          updated_at = now()
--     FROM (SELECT plugin_id,
--                  jsonb_set(manifest, '{plugin}',
--                            (manifest -> 'plugin') - 'logoKey' - 'category' - 'websiteURL' - 'starterPrompts') AS manifest
--             FROM plugin_registry
--            WHERE plugin_id IN (
--              'com.momo.plugins.drive',
--              'com.momo.plugins.github',
--              'com.momo.plugins.gmail',
--              'com.momo.plugins.google-calendar',
--              'com.momo.plugins.google-drive',
--              'com.momo.plugins.linear',
--              'com.momo.plugins.notion'
--            )) s
--    WHERE r.plugin_id = s.plugin_id
--      AND r.manifest IS DISTINCT FROM s.manifest;
-- -----------------------------------------------------------------------------
