#!/usr/bin/env python3
"""Official plugin manifests from measured vendor `tools/list` (#3944, ADR-0113 add. 2 E2/E4).

Input : ~/.cache/momo-scratch/3944-measure/<app>.tools-list.json  (scripts/plugins/measure_tools_list.sh)
Output: server/Fixtures/plugin-manifests/<app>.json  +  server/Migrations/143_official_catalog_c_s1b.sql

Every tool name, schemaDigest and (projected) inputSchema comes from those measured files and
nowhere else. The grade table below is the only hand-written part: R / A / B per ADR-0113
add. 2 E4. Grade C (delete, share, merge, push, permission, spam, session spawn, cancel) is
never listed, and neither is anything the table does not name (absence is the strongest refusal).

schemaDigest = sha256 over canonical JSON ({inputSchema, name}; keys sorted, no whitespace) of the
VENDOR tool exactly as measured (vendor name, vendor schema). The manifest's `inputSchema` is a
projection of it into the closed subset the validator admits (plugin_manifest.rs
validate_input_schema): unknown keywords ($schema, default, format, pattern, anyOf, ...) are
dropped, root `additionalProperties` is forced to false, secret-shaped property names are dropped.
"""
import hashlib
import json
import os
import re
import sys

MEASURE = os.path.expanduser('~/.cache/momo-scratch/3944-measure')
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))

SECRET_FRAGMENTS = ['credential', 'accesstoken', 'refreshtoken', 'oauthtoken', 'authorization',
                    'clientsecret', 'privatekey', 'password', 'bearertoken', 'apikey']

# name -> (grade, 한국어 설명).  R read | A write+require_approval | B write+always
APPS = {
    'github': dict(
        measured='github', prefix='github', plugin_id='com.momo.plugins.github', name='GitHub',
        version='1.1.0', description='Official GitHub hosted MCP integration',
        publisher=('github', 'GitHub'), license=('MIT', 'open_source'),
        source='https://github.com/github/github-mcp-server', release='hosted',
        url='https://api.githubcopilot.com/mcp/', server=('github/github-mcp-server', 'hosted'),
        egress=['api.githubcopilot.com'], recommended=['software-development', 'work-tracking'],
        scopes={'R': 'github:read', 'A': 'github:write', 'B': 'github:write'}, risk='medium',
        tools={
            'get_commit': ('R', '커밋 하나의 내용과 변경 파일을 조회합니다.'),
            'get_file_contents': ('R', '저장소의 파일 또는 디렉터리 내용을 읽습니다.'),
            'get_label': ('R', '저장소 라벨 하나를 조회합니다.'),
            'get_latest_release': ('R', '저장소의 최신 릴리스를 조회합니다.'),
            'get_me': ('R', '인증된 GitHub 사용자 정보를 조회합니다.'),
            'get_release_by_tag': ('R', '태그 이름으로 릴리스를 조회합니다.'),
            'get_tag': ('R', '태그 하나의 정보를 조회합니다.'),
            'get_team_members': ('R', '팀 구성원 목록을 조회합니다.'),
            'get_teams': ('R', '사용자가 속한 팀 목록을 조회합니다.'),
            'issue_read': ('R', '이슈의 본문, 댓글, 하위 이슈, 라벨을 읽습니다.'),
            'list_branches': ('R', '저장소의 브랜치 목록을 조회합니다.'),
            'list_commits': ('R', '브랜치의 커밋 목록을 조회합니다.'),
            'list_issue_fields': ('R', '이슈에 쓸 수 있는 사용자 지정 필드를 조회합니다.'),
            'list_issue_types': ('R', '조직의 이슈 유형 목록을 조회합니다.'),
            'list_issues': ('R', '저장소의 이슈 목록을 조회합니다.'),
            'list_pull_requests': ('R', '저장소의 풀 리퀘스트 목록을 조회합니다.'),
            'list_releases': ('R', '저장소의 릴리스 목록을 조회합니다.'),
            'list_repository_collaborators': ('R', '저장소 협업자 목록을 조회합니다.'),
            'list_tags': ('R', '저장소의 태그 목록을 조회합니다.'),
            'pull_request_read': ('R', '풀 리퀘스트의 본문, 변경 파일, 리뷰, 상태 점검을 읽습니다.'),
            'search_code': ('R', 'GitHub 전체에서 코드를 검색합니다.'),
            'search_commits': ('R', '커밋을 검색합니다.'),
            'search_issues': ('R', '권한을 위임한 사용자가 접근할 수 있는 저장소에서 이슈를 검색합니다.'),
            'search_pull_requests': ('R', '풀 리퀘스트를 검색합니다.'),
            'search_repositories': ('R', '저장소를 검색합니다.'),
            'search_users': ('R', 'GitHub 사용자를 검색합니다.'),
            'add_comment_to_pending_review': ('B', '내 대기 중인 리뷰에 코멘트를 추가합니다.'),
            'add_issue_comment': ('B', '이슈 또는 풀 리퀘스트에 댓글을 남깁니다.'),
            'add_reply_to_pull_request_comment': ('B', '풀 리퀘스트 리뷰 코멘트에 답글을 남깁니다.'),
            'create_branch': ('B', '저장소에 새 브랜치를 만듭니다.'),
            'create_pull_request': ('B', '풀 리퀘스트를 엽니다.'),
            'issue_write': ('B', '이슈를 만들거나 고칩니다.'),
            'pull_request_review_write': ('B', '풀 리퀘스트 리뷰를 만들고 제출합니다.'),
            'sub_issue_write': ('B', '하위 이슈를 추가하거나 순서를 바꿉니다.'),
            'update_issue_comment': ('B', '내가 쓴 이슈 댓글을 고칩니다.'),
            'update_pull_request': ('B', '풀 리퀘스트의 제목, 본문, 상태를 고칩니다.'),
        }),
    'notion': dict(
        measured='notion', prefix='notion', plugin_id='com.momo.plugins.notion', name='Notion',
        version='1.1.0', description='Official Notion hosted MCP integration',
        publisher=('makenotion', 'Notion'), license=('MIT', 'open_source'),
        source='https://github.com/makenotion/notion-mcp-server', release='hosted',
        url='https://mcp.notion.com/mcp', server=('makenotion/notion-mcp-server', 'hosted'),
        egress=['mcp.notion.com'], recommended=['knowledge-management', 'documentation'],
        scopes={'R': 'notion:read', 'A': 'notion:write', 'B': 'notion:write'}, risk='medium',
        tools={
            'notion-search': ('R', '권한을 위임한 사용자가 접근할 수 있는 페이지와 데이터베이스를 검색합니다.'),
            'notion-memory-search': ('R', '내 Notion 메모리를 검색합니다.'),
            'notion-fetch': ('R', '페이지나 데이터베이스의 내용을 가져옵니다.'),
            'notion-get-comments': ('R', '페이지의 댓글과 토론을 조회합니다.'),
            'notion-get-teams': ('R', '워크스페이스의 팀스페이스 목록을 조회합니다.'),
            'notion-get-groups': ('R', '워크스페이스의 사용자 그룹을 조회합니다.'),
            'notion-get-users': ('R', '워크스페이스 사용자 목록을 조회합니다.'),
            'notion-get-self': ('R', '연결된 내 Notion 계정 정보를 조회합니다.'),
            'notion-get-async-task': ('R', '비동기 작업의 진행 상태를 조회합니다.'),
            'notion-get-file-download-urls': ('R', '첨부 파일의 내려받기 주소를 조회합니다.'),
            'notion-download-attachment': ('R', '첨부 파일을 내려받습니다.'),
            'notion-query-data-sources': ('R', '데이터 소스를 조건으로 조회합니다.'),
            'notion-query-multiple-data-sources': ('R', '여러 데이터 소스를 한 번에 조회합니다.'),
            'notion-query-meeting-notes': ('R', '회의록을 조건으로 조회합니다.'),
            'notion-list-private-pages': ('R', '내 비공개 페이지 목록을 조회합니다.'),
            'notion-list-shared-pages': ('R', '나와 공유된 페이지 목록을 조회합니다.'),
            'notion-list-favorite-pages': ('R', '즐겨찾기 페이지 목록을 조회합니다.'),
            'notion-list-recent-pages': ('R', '최근 페이지 목록을 조회합니다.'),
            'notion-list-page-backlinks': ('R', '페이지를 가리키는 링크 목록을 조회합니다.'),
            'notion-calendar-list-calendars': ('R', 'Notion 캘린더 목록을 조회합니다.'),
            'notion-calendar-list-events': ('R', 'Notion 캘린더의 일정을 조회합니다.'),
            'notion-calendar-list-coworkers-events': ('R', '동료의 일정을 조회합니다.'),
            'notion-calendar-list-calendar-resources': ('R', '캘린더 자원(회의실 등)을 조회합니다.'),
            'notion-calendar-list-contacts': ('R', '캘린더 연락처를 조회합니다.'),
            'notion-create-pages': ('A', '페이지를 새로 만듭니다.'),
            'notion-create-database': ('A', '데이터베이스를 새로 만듭니다.'),
            'notion-duplicate-page': ('A', '페이지를 복제합니다.'),
            'notion-create-view': ('A', '데이터베이스 보기를 만듭니다.'),
            'notion-update-view': ('A', '데이터베이스 보기를 고칩니다.'),
            'notion-create-folder': ('A', '폴더를 만듭니다.'),
            'notion-create-file-upload': ('A', '파일 올리기를 시작합니다.'),
            'notion-create-attachment': ('A', '올린 파일을 페이지에 첨부합니다.'),
            'notion-create-comment': ('B', '페이지에 댓글을 남깁니다.'),
            'notion-update-comment': ('B', '내가 쓴 댓글을 고칩니다.'),
            'notion-set-discussion-resolved': ('B', '토론을 해결됨으로 표시하거나 되돌립니다.'),
            'notion-set-comment-reaction': ('B', '댓글에 반응을 남기거나 지웁니다.'),
            'notion-calendar-create-events': ('B', 'Notion 캘린더에 일정을 만듭니다.'),
            'notion-calendar-update-events': ('B', 'Notion 캘린더의 일정을 고칩니다.'),
        }),
    'linear': dict(
        measured='linear', prefix='linear', plugin_id='com.momo.plugins.linear', name='Linear',
        version='1.1.0', description='Official Linear hosted MCP integration',
        publisher=('linear', 'Linear'), license=('LicenseRef-Linear-Hosted-Service', 'hosted_only'),
        source='https://linear.app/docs/mcp', release='hosted',
        url='https://mcp.linear.app/mcp', server=('linear-hosted-mcp', 'hosted'),
        egress=['mcp.linear.app'], recommended=['work-tracking', 'product-development'],
        scopes={'R': 'linear:read', 'A': 'linear:write', 'B': 'linear:write'}, risk='medium',
        tools={
            'get_attachment': ('R', '이슈 첨부 하나를 조회합니다.'),
            'list_comments': ('R', '이슈의 댓글 목록을 조회합니다.'),
            'list_cycles': ('R', '팀의 사이클 목록을 조회합니다.'),
            'list_custom_views': ('R', '사용자 지정 보기 목록을 조회합니다.'),
            'get_document': ('R', '문서 하나를 조회합니다.'),
            'list_documents': ('R', '문서 목록을 조회합니다.'),
            'extract_images': ('R', '마크다운에서 이미지를 추출해 보여줍니다.'),
            'get_issue': ('R', '이슈 하나를 조회합니다.'),
            'list_issues': ('R', '권한을 위임한 사용자가 접근할 수 있는 이슈 목록을 조회합니다.'),
            'list_issue_statuses': ('R', '팀의 이슈 상태 목록을 조회합니다.'),
            'get_issue_status': ('R', '이슈 상태 하나를 조회합니다.'),
            'list_issue_labels': ('R', '이슈 라벨 목록을 조회합니다.'),
            'list_projects': ('R', '프로젝트 목록을 조회합니다.'),
            'get_project': ('R', '프로젝트 하나를 조회합니다.'),
            'list_project_labels': ('R', '프로젝트 라벨 목록을 조회합니다.'),
            'list_releases': ('R', '릴리스 목록을 조회합니다.'),
            'get_release': ('R', '릴리스 하나를 조회합니다.'),
            'list_release_notes': ('R', '릴리스 노트 목록을 조회합니다.'),
            'get_release_note': ('R', '릴리스 노트 하나를 조회합니다.'),
            'list_release_pipelines': ('R', '릴리스 파이프라인 목록을 조회합니다.'),
            'list_milestones': ('R', '프로젝트 마일스톤 목록을 조회합니다.'),
            'get_milestone': ('R', '마일스톤 하나를 조회합니다.'),
            'get_notifications': ('R', '내 알림 목록을 조회합니다.'),
            'list_teams': ('R', '워크스페이스의 팀 목록을 조회합니다.'),
            'get_team': ('R', '팀 하나를 조회합니다.'),
            'get_triage_responsibility': ('R', '팀의 분류 담당 설정을 조회합니다.'),
            'list_templates': ('R', '템플릿 목록을 조회합니다.'),
            'get_template': ('R', '템플릿 하나를 조회합니다.'),
            'list_users': ('R', '워크스페이스 사용자 목록을 조회합니다.'),
            'get_user': ('R', '사용자 한 명을 조회합니다.'),
            'get_workspace': ('R', '워크스페이스 정보를 조회합니다.'),
            'search_documentation': ('R', 'Linear 도움말 문서를 검색합니다.'),
            'get_status_updates': ('R', '프로젝트·이니셔티브 상태 업데이트를 조회합니다.'),
            'mark_notification': ('A', '내 알림을 읽음 처리하거나 되돌립니다.'),
            'save_comment': ('B', '이슈에 댓글을 만들거나 고칩니다.'),
            'save_issue': ('B', '이슈를 만들거나 고칩니다.'),
            'save_project': ('B', '프로젝트를 만들거나 고칩니다.'),
            'save_document': ('B', '문서를 만들거나 고칩니다.'),
            'save_milestone': ('B', '마일스톤을 만들거나 고칩니다.'),
            'save_status_update': ('B', '프로젝트 상태 업데이트를 남기거나 고칩니다.'),
        }),
    'gmail': dict(
        measured='google-gmail', prefix='gmail', plugin_id='com.momo.plugins.gmail', name='Gmail',
        version='1.0.0', description='Official Google Gmail remote MCP (Developer Preview): read mail, create drafts, label. No send.',
        publisher=('google', 'Google'), license=('LicenseRef-Google-Hosted-Service', 'hosted_only'),
        source='https://developers.google.com/workspace/guides/configure-mcp-servers', release='hosted',
        url='https://gmailmcp.googleapis.com/mcp/v1', server=('google/gmail-mcp', 'preview'),
        egress=['gmailmcp.googleapis.com'], recommended=['communication', 'productivity'],
        scopes={'R': 'gmail:read', 'A': 'gmail:draft', 'B': 'gmail:draft'}, risk='medium', preview=True,
        tools={
            'list_drafts': ('R', '내 초안 목록을 조회합니다.'),
            'get_draft': ('R', '초안 하나를 읽습니다.'),
            'get_thread': ('R', '메일 스레드를 읽습니다.'),
            'get_message': ('R', '메일 한 통을 읽습니다.'),
            'search_threads': ('R', '메일 스레드를 검색합니다.'),
            'list_labels': ('R', '내 라벨 목록을 조회합니다.'),
            'create_draft': ('A', '메일 초안을 만듭니다. 보내지는 않아요. 보내기는 Gmail에서 직접 해요.'),
            'create_label': ('A', '라벨을 새로 만듭니다.'),
            'label_thread': ('B', '스레드에 라벨을 붙입니다.'),
            'unlabel_thread': ('B', '스레드에서 라벨을 뗍니다.'),
            'label_message': ('B', '메일 한 통에 라벨을 붙입니다.'),
            'unlabel_message': ('B', '메일 한 통에서 라벨을 뗍니다.'),
            'update_message_labels': ('B', '메일 한 통의 라벨을 한 번에 바꿉니다.'),
        }),
    'google-calendar': dict(
        measured='google-calendar', prefix='google-calendar', plugin_id='com.momo.plugins.google-calendar',
        name='Google Calendar', version='1.0.0',
        description='Official Google Calendar remote MCP (Developer Preview)',
        publisher=('google', 'Google'), license=('LicenseRef-Google-Hosted-Service', 'hosted_only'),
        source='https://developers.google.com/workspace/guides/configure-mcp-servers', release='hosted',
        url='https://calendarmcp.googleapis.com/mcp/v1', server=('google/calendar-mcp', 'preview'),
        egress=['calendarmcp.googleapis.com'], recommended=['scheduling', 'productivity'],
        scopes={'R': 'google-calendar:read', 'A': 'google-calendar:write', 'B': 'google-calendar:write'},
        risk='medium', preview=True,
        tools={
            'list_events': ('R', '캘린더의 일정 목록을 조회합니다.'),
            'get_event': ('R', '일정 하나를 조회합니다.'),
            'list_calendars': ('R', '내 캘린더 목록을 조회합니다.'),
            'suggest_time': ('R', '참석자들이 모두 비는 시간을 제안합니다.'),
            'search_events': ('R', '일정을 검색합니다.'),
            'create_event': ('B', '일정을 만듭니다. 참석자가 있으면 초대가 나가요.'),
            'update_event': ('B', '일정을 고칩니다. 참석자에게 알림이 갈 수 있어요.'),
            'respond_to_event': ('B', '초대받은 일정에 참석 여부를 답합니다.'),
        }),
    'google-drive': dict(
        measured='google-drive', prefix='google-drive', plugin_id='com.momo.plugins.google-drive',
        name='Google 내 드라이브', version='1.0.0',
        description='Official Google Drive remote MCP (Developer Preview), the signed-in person\'s own Drive',
        publisher=('google', 'Google'), license=('LicenseRef-Google-Hosted-Service', 'hosted_only'),
        source='https://developers.google.com/workspace/guides/configure-mcp-servers', release='hosted',
        url='https://drivemcp.googleapis.com/mcp/v1', server=('google/drive-mcp', 'preview'),
        egress=['drivemcp.googleapis.com'], recommended=['knowledge-management', 'productivity'],
        scopes={'R': 'google-drive:read', 'A': 'google-drive:write', 'B': 'google-drive:write'},
        risk='medium', preview=True,
        tools={
            'search_files': ('R', '내 드라이브에서 파일을 검색합니다.'),
            'list_recent_files': ('R', '최근 파일 목록을 조회합니다.'),
            'get_file_metadata': ('R', '파일의 메타데이터를 조회합니다.'),
            'get_file_permissions': ('R', '파일의 공유 설정을 조회합니다.'),
            'read_file_content': ('R', '파일 내용을 텍스트로 읽습니다.'),
            'download_file_content': ('R', '파일 내용을 내려받습니다.'),
            'create_file': ('A', '내 드라이브에 파일을 만듭니다.'),
            'copy_file': ('A', '파일을 복사합니다.'),
        }),
}

GRADE = {
    'R': ('read', 'none', 'read_only'),
    'A': ('write', 'require_approval', 'network_write'),
    'B': ('write', 'always', 'network_write'),
}
# Tools whose ARGUMENTS can delete / trash / overwrite are left out even when their name is harmless
# (review of #3944: notion-update-data-source `in_trash`, notion-update-page `allow_deleting_content`,
# notion-update-folder `remove_files`). Every other graded write tool whose schema mentions one of
# these words in a property name or enum value must be listed here with the reason it stays - a new
# hit fails the build instead of passing silently.
RISKY_ARG = re.compile(r'trash|archiv|delet|spam|permission|drop|remove|purge|destroy|erase|overwrite|replace', re.I)
RISKY_ARG_REVIEWED = {
    'github.issue_write': 'issue_fields.delete clears a custom field value on the caller\'s issue (reversible edit)',
    'github.pull_request_review_write': 'method=delete_pending deletes only the caller\'s own unsubmitted draft review',
    'github.sub_issue_write': 'replace_parent re-parents a sub issue (reversible edit)',
    'linear.save_issue': 'remove* args unlink labels/relations on an issue (reversible edit)',
    'linear.save_project': 'removeTeams/removeInitiatives unlink; patch.replace_all replaces a text field',
    'linear.save_document': 'patch.replace_all replaces the document text (document history kept by Linear)',
    'google-calendar.create_event': 'guestPermissions only sets what guests may do',
    'google-calendar.update_event': 'removedAttendeeEmails/removedAttachmentFileUrls edit one event (B: attendees are notified)',
    'gmail.update_message_labels': 'removeLabelIds un-labels; graded B because a system label such as TRASH/SPAM may be accepted (unmeasured)',
}

GRADE_C = [r'^delete', r'^notion-delete', r'^trash', r'^(un)?share_', r'^merge', r'^push_files$', r'^create_or_update_file$',
           r'spam', r'^notion-move', r'cancel', r'spawn', r'^manage', r'send']


def canonical(v):
    if isinstance(v, list):
        return '[' + ','.join(canonical(x) for x in v) + ']'
    if isinstance(v, dict):
        return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + canonical(v[k]) for k in sorted(v)) + '}'
    return json.dumps(v, ensure_ascii=False)


def digest(tool):
    body = canonical({'inputSchema': tool.get('inputSchema'), 'name': tool['name']})
    return 'sha256:' + hashlib.sha256(body.encode('utf-8')).hexdigest()


def secret_like(key):
    folded = re.sub(r'[_\-. ]', '', key).lower()
    return any(f in folded for f in SECRET_FRAGMENTS)


LOSSY = []


def prop(schema, where):
    """Project one property schema into the validator's subset; None = cannot be expressed."""
    if not isinstance(schema, dict):
        return None
    t = schema.get('type')
    if isinstance(t, list):
        t = next((x for x in t if x != 'null'), None)
    if t is None:
        for key in ('anyOf', 'oneOf'):
            for branch in schema.get(key, []) or []:
                got = prop({**{k: v for k, v in schema.items() if k not in ('anyOf', 'oneOf')}, **branch}, where)
                if got:
                    LOSSY.append(f'{where}: {key} -> first typed branch')
                    return got
        return None
    if t not in ('string', 'integer', 'number', 'boolean', 'array', 'object'):
        return None
    out = {'type': t}
    d = schema.get('description')
    if isinstance(d, str):
        out['description'] = d[:300]
    en = schema.get('enum')
    if isinstance(en, list) and en and all(not isinstance(x, (dict, list)) for x in en):
        out['enum'] = en
    for k in ('minLength', 'maxLength', 'minimum', 'maximum'):
        if k in schema and not isinstance(schema[k], bool):
            out[k] = schema[k]
    if t == 'array':
        items = prop(schema.get('items'), where + '[]')
        if not items:
            return None
        out['items'] = items
    if t == 'object':
        # validate_input_schema admits only type/properties/required/additionalProperties here.
        out = obj(schema, where)
    dropped = set(schema) - set(out) - {'description'}
    if dropped - {'default', 'format', 'pattern', 'x-mcp-header', 'x-google-enum-descriptions', 'minItems',
                  'maxItems', 'const', 'readOnly', 'deprecated', 'exclusiveMinimum', 'propertyNames', '$schema',
                  'title', 'examples'}:
        LOSSY.append(f'{where}: dropped {sorted(dropped)}')
    return out


def obj(schema, where):
    props = {}
    for name, sub in (schema.get('properties') or {}).items():
        if secret_like(name):
            LOSSY.append(f'{where}.{name}: secret-shaped name dropped')
            continue
        got = prop(sub, f'{where}.{name}')
        if got is None:
            LOSSY.append(f'{where}.{name}: not expressible, dropped')
            continue
        props[name] = got
    out = {'type': 'object', 'properties': props, 'additionalProperties': False}
    req = [r for r in (schema.get('required') or []) if r in props]
    if req:
        out['required'] = req
    return out


def risky_walk(schema, path, hits):
    if isinstance(schema, dict):
        for k, v in schema.items():
            if k == 'properties' and isinstance(v, dict):
                for pk, pv in v.items():
                    if RISKY_ARG.search(pk):
                        hits.append(f'{path}.{pk}')
                    risky_walk(pv, f'{path}.{pk}', hits)
            else:
                if k == 'enum' and isinstance(v, list):
                    hits.extend(f'{path}={e}' for e in v if isinstance(e, str) and RISKY_ARG.search(e))
                risky_walk(v, path, hits)
    elif isinstance(schema, list):
        for x in schema:
            risky_walk(x, path, hits)


def build(key, app):
    measured = json.load(open(f"{MEASURE}/{app['measured']}.tools-list.json"))['tools']
    by_name = {t['name']: t for t in measured}
    tools, tiers = [], {}
    for vendor_name, (grade, desc) in app['tools'].items():
        if any(re.search(p, vendor_name) for p in GRADE_C):
            sys.exit(f'{key}.{vendor_name}: grade C name in the table')
        if vendor_name not in by_name:
            sys.exit(f'{key}.{vendor_name}: not in the measured tools/list')
        t = by_name[vendor_name]
        ann = t.get('annotations') or {}
        if grade == 'R' and ann.get('readOnlyHint') is False:
            sys.exit(f'{key}.{vendor_name}: graded R but readOnlyHint=false')
        if grade != 'R' and ann.get('readOnlyHint') is True:
            sys.exit(f'{key}.{vendor_name}: graded {grade} but readOnlyHint=true')
        # Vendor destructiveHint = it can overwrite or remove existing data: never below B.
        if ann.get('destructiveHint') is True and grade != 'B':
            sys.exit(f'{key}.{vendor_name}: destructiveHint=true but graded {grade}')
        if grade != 'R':
            hits = []
            risky_walk(t.get('inputSchema'), '', hits)
            if hits and f"{app['prefix']}.{vendor_name}" not in RISKY_ARG_REVIEWED:
                sys.exit(f"{key}.{vendor_name}: risky argument(s) {hits[:4]} - drop the tool or review it in RISKY_ARG_REVIEWED")
        risk, policy, tier = GRADE[grade]
        name = f"{app['prefix']}.{vendor_name}"
        tools.append({
            'name': name, 'description': desc,
            'inputSchema': obj(t.get('inputSchema') or {}, name),
            'schemaDigest': digest(t),
            'scopes': [app['scopes'][grade]], 'risk': risk, 'approvalPolicy': policy,
        })
        tiers[name] = tier
    momo = {'approvalTier': tiers, 'risk': app['risk'], 'egressDomains': app['egress'],
            'recommendedFor': app['recommended'],
            'serverPolicy': {'installAllowed': True, 'enabledByDefault': False, 'allowedRoles': ['owner', 'admin']}}
    if app.get('preview'):
        momo['preview'] = True
    return {
        'schemaVersion': 'momo.plugin.v1',
        'plugin': {'id': app['plugin_id'], 'name': app['name'], 'version': app['version'],
                   'description': app['description'],
                   'publisher': {'id': app['publisher'][0], 'name': app['publisher'][1], 'verified': True},
                   'license': {'spdx': app['license'][0], 'kind': app['license'][1]},
                   'provenance': {'sourceURL': app['source'], 'releaseRef': app['release'], 'verified': True}},
        'mcp': {'protocolVersion': '2025-06-18', 'transport': 'streamable_http', 'url': app['url'],
                'server': {'name': app['server'][0], 'version': app['server'][1]}, 'tools': tools},
        'skill': {'reference': None, 'optional': True},
        'momo': momo,
    }


EXISTING = ['github', 'notion', 'linear']   # rows seeded by 013 (031/059 touched them)
MIGRATION = 'server/Migrations/143_official_catalog_c_s1b.sql'

HEADER = """-- =============================================================================
-- 143_official_catalog_c_s1b.sql - #3944 (C-S1b), ADR-0113 add. 2 E2 / E4 / E7
--
-- Official catalogue from MEASURED vendor tools/list (scripts/plugins/measure_tools_list.sh;
-- GitHub 46, Notion 65, Linear 68, Gmail 23, Calendar 9, Drive 8 tools, 2026-10-19). Generated
-- by scripts/plugins/gen_official_manifests.py; the same JSON is the fixture under
-- server/Fixtures/plugin-manifests/ (the fixture is canon, this file must equal it).
--
--  * github / notion / linear (013, 031, 059): manifest REPLACED, version 1.0.0 -> 1.1.0, digest
--    rotated with the same expression the runtime uses. Tool names are now
--    `<app>.<vendor tool name as is>`: github.list_repositories (never a GitHub tool) ->
--    github.search_repositories, notion.search -> notion.notion-search. linear.list_issues and
--    github.search_issues are already vendor names and keep their name.
--  * gmail / google-calendar / google-drive ("내 드라이브", user OAuth, momo.preview): new rows.
--    Drive 013's com.momo.plugins.drive (team shared drive, path C) is untouched.
--  * Grades (E4): R read/none/read_only, A write/require_approval/network_write, B write/always/
--    network_write. Grade C (delete, share, merge, push, permission, spam, session spawn, cancel,
--    send) is not listed, and neither is anything not named in the generator's table. Gmail has
--    no send tool by construction (the vendor has none). Tools whose ARGUMENTS can delete are left
--    out too: notion-update-page (allow_deleting_content), notion-update-data-source (in_trash),
--    notion-update-folder (remove_files); the generator fails on any new delete-ish argument that
--    was not reviewed. The three Gmail label tools are B because a system label such as
--    TRASH/SPAM may be accepted by the vendor (unmeasured).
--  * schemaDigest = sha256 over canonical JSON ({inputSchema, name}, keys sorted) of the VENDOR
--    tool as measured. The manifest inputSchema is its projection into the closed subset the
--    validator admits (unknown keywords dropped, root additionalProperties false); nothing
--    recomputes the digest at runtime (the validator checks its shape only).
--  * No client_id / client_secret / token anywhere (E6).
--
-- Capability projections of existing active grants of the three replaced apps are rebuilt from
-- the new manifest (names changed, tools were added) - only when this migration runs as a role
-- that bypasses RLS (superuser / BYPASSRLS, i.e. the migration owner in every supported
-- setup); otherwise a NOTICE is raised and a re-grant refreshes a member's rows.
-- Idempotent: the UPDATE only fires on a different manifest, the INSERT on conflict is a no-op.
-- =============================================================================

"""


def sql_for(manifests):
    out = [HEADER]
    out.append('WITH new_manifest(plugin_id, version, manifest) AS (\n  VALUES\n')
    rows = []
    for k in EXISTING:
        m = manifests[k]
        rows.append(f"  (\n    '{m['plugin']['id']}',\n    '{m['plugin']['version']}',\n    $manifest$\n"
                    f"{json.dumps(m, ensure_ascii=False, indent=2)}\n    $manifest$::jsonb\n  )")
    out.append(',\n'.join(rows))
    out.append("""
)
UPDATE plugin_registry r
   SET version = n.version,
       manifest = n.manifest,
       manifest_digest = 'sha256:' || encode(sha256(convert_to(n.manifest::text, 'UTF8')), 'hex'),
       updated_at = now()
  FROM new_manifest n
 WHERE r.plugin_id = n.plugin_id
   AND r.manifest IS DISTINCT FROM n.manifest;

WITH seed(plugin_id, version, manifest) AS (
  VALUES
""")
    rows = []
    for k in ['gmail', 'google-calendar', 'google-drive']:
        m = manifests[k]
        rows.append(f"  (\n    '{m['plugin']['id']}',\n    '{m['plugin']['version']}',\n    $manifest$\n"
                    f"{json.dumps(m, ensure_ascii=False, indent=2)}\n    $manifest$::jsonb\n  )")
    out.append(',\n'.join(rows))
    out.append("""
)
INSERT INTO plugin_registry (plugin_id, version, manifest, manifest_digest, official)
SELECT plugin_id,
       version,
       manifest,
       'sha256:' || encode(sha256(convert_to(manifest::text, 'UTF8')), 'hex'),
       true
  FROM seed
ON CONFLICT (plugin_id) DO NOTHING;

DO $$
BEGIN
  IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    DELETE FROM plugin_capability_projection
     WHERE plugin_id IN ('com.momo.plugins.github', 'com.momo.plugins.notion', 'com.momo.plugins.linear');
    INSERT INTO plugin_capability_projection
      (workspace_id, member_id, plugin_id, scope, tool_name, capability_version,
       schema_digest, risk, approval_tier, grant_id)
    SELECT g.workspace_id, g.member_id, g.plugin_id, g.scope, t.value->>'name', r.version,
           t.value->>'schemaDigest', t.value->>'risk',
           r.manifest#>>ARRAY['momo','approvalTier', t.value->>'name'], g.id
      FROM plugin_grant g
      JOIN plugin_registry r ON r.plugin_id = g.plugin_id
      CROSS JOIN LATERAL jsonb_array_elements(r.manifest#>'{mcp,tools}') AS t(value)
     WHERE g.status = 'active'
       AND g.plugin_id IN ('com.momo.plugins.github', 'com.momo.plugins.notion', 'com.momo.plugins.linear')
       AND t.value->'scopes' ? g.scope;
  ELSE
    RAISE NOTICE '143: role cannot bypass RLS; capability projections of existing grants keep their old rows until re-granted';
  END IF;
END $$;
""")
    return ''.join(out)


def main():
    manifests = {k: build(k, a) for k, a in APPS.items()}
    fx = os.path.join(ROOT, 'server/Fixtures/plugin-manifests')
    for k, m in manifests.items():
        with open(os.path.join(fx, f'{k}.json'), 'w') as f:
            json.dump(m, f, ensure_ascii=False, indent=2)
            f.write('\n')
    open(os.path.join(ROOT, MIGRATION), 'w').write(sql_for(manifests))
    json.dump(LOSSY, open(os.path.expanduser('~/.cache/momo-scratch/3944-measure/lossy-projection.json'), 'w'), indent=1)
    print({k: len(m['mcp']['tools']) for k, m in manifests.items()}, 'lossy notes:', len(LOSSY))


if __name__ == '__main__':
    main()
