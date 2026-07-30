-- =============================================================================
-- 059_official_manifest_tool_description_ko.sql — MOMO-680 / #921
--
-- 자사(momo 카탈로그) 매니페스트의 tools[].description 을 한국어로 재시드한다.
-- 013/015 가 심고 031 이 확장한 레지스트리 행이 대상이고, 정본은
-- server/Fixtures/plugin-manifests/*.json 이다(같은 문자열, 같은 도구 이름).
--
-- 경계(웹 레인이 #914/#917 에서 세운 원칙을 되돌리지 않는다):
--   동의 다이얼로그는 배포자 자유 문구를 결정 문구로 승격하지 않고 도구 이름으로
--   식별한다. 배포자 산문은 증거 표면(앱 상세 > 도구와 권한)에만 남는다. 제3자
--   매니페스트는 어떤 언어로도 들어올 수 있어 데이터 번역이 근본 해법이 아니다 —
--   이 마이그레이션은 자사 카탈로그 4종의 문구 품질만 다룬다.
--
-- 왜 digest 를 함께 회전시키나: plugin_registry.manifest_digest 는 런타임 admission
-- 의 expected 값이고, PluginRoutes.registryRow 가 computed 값으로
-- 'sha256:' || encode(sha256(convert_to(manifest::text,'UTF8')),'hex') 를 계산해
-- 대조한다(불일치 = fail-closed). manifest 만 바꾸면 카탈로그 전체가 409 로 닫힌다.
-- 아래 UPDATE 는 런타임과 같은 식을 그대로 쓴다.
--
-- 멱등: 대상은 (plugin_id, 도구 이름, 기존 영문 description) 3-튜플이 정확히
-- 일치하는 도구뿐이고, 재실행 시에는 이미 한국어라 매칭되지 않아 manifest 가
-- 그대로여서 IS DISTINCT FROM 조건이 0행을 남긴다. 배포자가 손댄 매니페스트도
-- 같은 이유로 덮어쓰지 않는다.
-- =============================================================================

WITH ko(plugin_id, tool_name, legacy_description, description) AS (
  VALUES
    (
      'com.momo.plugins.github'::text,
      'github.list_repositories'::text,
      'List repositories available to the delegated user'::text,
      '권한을 위임한 사용자가 접근할 수 있는 저장소 목록을 조회합니다.'::text
    ),
    (
      'com.momo.plugins.github',
      'github.search_issues',
      'Search issues in repositories available to the delegated user',
      '권한을 위임한 사용자가 접근할 수 있는 저장소에서 이슈를 검색합니다.'
    ),
    (
      'com.momo.plugins.notion',
      'notion.search',
      'Search pages available to the delegated user',
      '권한을 위임한 사용자가 접근할 수 있는 페이지를 검색합니다.'
    ),
    (
      'com.momo.plugins.linear',
      'linear.list_issues',
      'List issues available to the delegated user',
      '권한을 위임한 사용자가 접근할 수 있는 이슈 목록을 조회합니다.'
    ),
    (
      'com.momo.plugins.drive',
      'drive.search_files',
      'Search files within the configured shared drive',
      '설정된 공유 드라이브 안에서 파일을 검색합니다.'
    ),
    (
      'com.momo.plugins.drive',
      'drive.get_file_metadata',
      'Get metadata for a file in the configured shared drive',
      '설정된 공유 드라이브에 있는 파일의 메타데이터를 조회합니다.'
    ),
    (
      'com.momo.plugins.drive',
      'drive.export_text',
      'Export a Google Workspace document or download a bounded text file',
      'Google Workspace 문서를 텍스트로 내보내거나 크기 한도 안의 텍스트 파일을 내려받습니다.'
    )
),
-- 도구 배열은 이름으로 매칭해 다시 쓴다: 031 이 github 에 search_issues 를 덧붙인
-- 뒤라 인덱스 고정은 깨지기 쉽고, 배열 순서는 배포자가 선언한 제품 순서라 보존한다.
rewritten AS (
  SELECT pr.plugin_id,
         jsonb_set(
           pr.manifest,
           '{mcp,tools}',
           (
             SELECT jsonb_agg(
                      CASE
                        WHEN ko.description IS NULL THEN t.tool
                        ELSE jsonb_set(t.tool, '{description}', to_jsonb(ko.description))
                      END
                      ORDER BY t.ord
                    )
               FROM jsonb_array_elements(pr.manifest #> '{mcp,tools}')
                    WITH ORDINALITY AS t(tool, ord)
               LEFT JOIN ko
                 ON ko.plugin_id = pr.plugin_id
                AND ko.tool_name = t.tool ->> 'name'
                AND ko.legacy_description = t.tool ->> 'description'
           )
         ) AS manifest
    FROM plugin_registry pr
   WHERE pr.plugin_id IN (SELECT DISTINCT plugin_id FROM ko)
     AND jsonb_typeof(pr.manifest #> '{mcp,tools}') = 'array'
     AND jsonb_array_length(pr.manifest #> '{mcp,tools}') > 0
)
UPDATE plugin_registry pr
   SET manifest = rw.manifest,
       manifest_digest = 'sha256:' || encode(sha256(convert_to(rw.manifest::text, 'UTF8')), 'hex'),
       updated_at = now()
  FROM rewritten rw
 WHERE pr.plugin_id = rw.plugin_id
   AND pr.manifest IS DISTINCT FROM rw.manifest;
