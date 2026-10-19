-- =============================================================================
-- 142_official_catalog_c_s1b.sql - #3944 (C-S1b), ADR-0113 add. 2 E2 / E4 / E7
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

WITH new_manifest(plugin_id, version, manifest) AS (
  VALUES
  (
    'com.momo.plugins.github',
    '1.1.0',
    $manifest$
{
  "schemaVersion": "momo.plugin.v1",
  "plugin": {
    "id": "com.momo.plugins.github",
    "name": "GitHub",
    "version": "1.1.0",
    "description": "Official GitHub hosted MCP integration",
    "publisher": {
      "id": "github",
      "name": "GitHub",
      "verified": true
    },
    "license": {
      "spdx": "MIT",
      "kind": "open_source"
    },
    "provenance": {
      "sourceURL": "https://github.com/github/github-mcp-server",
      "releaseRef": "hosted",
      "verified": true
    }
  },
  "mcp": {
    "protocolVersion": "2025-06-18",
    "transport": "streamable_http",
    "url": "https://api.githubcopilot.com/mcp/",
    "server": {
      "name": "github/github-mcp-server",
      "version": "hosted"
    },
    "tools": [
      {
        "name": "github.get_commit",
        "description": "커밋 하나의 내용과 변경 파일을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "detail": {
              "type": "string",
              "description": "Level of detail to include for changed files. \"none\" omits stats and files entirely. \"stats\" (default) includes per-file metadata: filename, status, and lines-of-code counts (additions, deletions, changes), with no patch content. \"full_patch\" additionally includes the unified diff content for each f",
              "enum": [
                "none",
                "stats",
                "full_patch"
              ]
            },
            "owner": {
              "type": "string",
              "description": "Repository owner"
            },
            "page": {
              "type": "number",
              "description": "Page number for pagination (min 1)",
              "minimum": 1
            },
            "perPage": {
              "type": "number",
              "description": "Results per page for pagination (min 1, max 100)",
              "minimum": 1,
              "maximum": 100
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            },
            "sha": {
              "type": "string",
              "description": "Commit SHA, branch name, or tag name"
            }
          },
          "additionalProperties": false,
          "required": [
            "owner",
            "repo",
            "sha"
          ]
        },
        "schemaDigest": "sha256:ca98cc7a2fc4e157aa357ccf6b032cd0fce638e3ecd8179de2e4751649010125",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.get_file_contents",
        "description": "저장소의 파일 또는 디렉터리 내용을 읽습니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "fields": {
              "type": "array",
              "description": "Subset of fields to return for each entry when the path is a directory. If omitted, all fields are returned. Ignored when the path is a single file. Use this to reduce response size when listing directories and you only need specific fields, e.g. just 'name' and 'type'.",
              "items": {
                "type": "string",
                "enum": [
                  "type",
                  "name",
                  "path",
                  "size",
                  "sha",
                  "url",
                  "git_url",
                  "html_url",
                  "download_url"
                ]
              }
            },
            "owner": {
              "type": "string",
              "description": "Repository owner (username or organization)"
            },
            "path": {
              "type": "string",
              "description": "Path to file/directory"
            },
            "ref": {
              "type": "string",
              "description": "Accepts optional git refs such as `refs/tags/{tag}`, `refs/heads/{branch}` or `refs/pull/{pr_number}/head`"
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            },
            "sha": {
              "type": "string",
              "description": "Accepts optional commit SHA. If specified, it will be used instead of ref"
            }
          },
          "additionalProperties": false,
          "required": [
            "owner",
            "repo"
          ]
        },
        "schemaDigest": "sha256:e89afab97ec7c4083b7084e3b1e3fec7b593587b9744c4a2c083bd1c049854b3",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.get_label",
        "description": "저장소 라벨 하나를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "name": {
              "type": "string",
              "description": "Label name."
            },
            "owner": {
              "type": "string",
              "description": "Repository owner (username or organization name)"
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            }
          },
          "additionalProperties": false,
          "required": [
            "owner",
            "repo",
            "name"
          ]
        },
        "schemaDigest": "sha256:29a8c8c2c8f863f0f5ff33b870b76faff556bee23df32f013e683d6790acbcee",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.get_latest_release",
        "description": "저장소의 최신 릴리스를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "owner": {
              "type": "string",
              "description": "Repository owner"
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            }
          },
          "additionalProperties": false,
          "required": [
            "owner",
            "repo"
          ]
        },
        "schemaDigest": "sha256:6bf57b1d12245e24ed7ec64d8e04d25002e357b14698b9e7e83ac9718ed4e7ed",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.get_me",
        "description": "인증된 GitHub 사용자 정보를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {},
          "additionalProperties": false
        },
        "schemaDigest": "sha256:1f2facd698addc9a5892480ea4adc64929020f106a525ba23d0a83cbbc8992f4",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.get_release_by_tag",
        "description": "태그 이름으로 릴리스를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "owner": {
              "type": "string",
              "description": "Repository owner"
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            },
            "tag": {
              "type": "string",
              "description": "Tag name (e.g., 'v1.0.0')"
            }
          },
          "additionalProperties": false,
          "required": [
            "owner",
            "repo",
            "tag"
          ]
        },
        "schemaDigest": "sha256:755d661a3d8307d99c827933979ee3f63c63952128f8f21ecad54be42949d386",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.get_tag",
        "description": "태그 하나의 정보를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "owner": {
              "type": "string",
              "description": "Repository owner"
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            },
            "tag": {
              "type": "string",
              "description": "Tag name"
            }
          },
          "additionalProperties": false,
          "required": [
            "owner",
            "repo",
            "tag"
          ]
        },
        "schemaDigest": "sha256:9b6c04fcd63703a96352dbec19242dbc6c6762218fe9fdc1a50ac0ee2b1c8fd5",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.get_team_members",
        "description": "팀 구성원 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "org": {
              "type": "string",
              "description": "Organization login (owner) that contains the team."
            },
            "team_slug": {
              "type": "string",
              "description": "Team slug"
            }
          },
          "additionalProperties": false,
          "required": [
            "org",
            "team_slug"
          ]
        },
        "schemaDigest": "sha256:636e440d768fee1ddf88d5eab17990158dbdea8d5e0cf71a5b713186eab3d977",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.get_teams",
        "description": "사용자가 속한 팀 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "user": {
              "type": "string",
              "description": "Username to get teams for. If not provided, uses the authenticated user."
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:9e7d6200cbfd8036c42b2107acfa84fef2b25dd53658af49e1e5c1cb6be30bb9",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.issue_read",
        "description": "이슈의 본문, 댓글, 하위 이슈, 라벨을 읽습니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "issue_number": {
              "type": "number",
              "description": "The number of the issue"
            },
            "method": {
              "type": "string",
              "description": "The read operation to perform on a single issue.\nOptions are:\n1. get - Get issue details. Also returns best-effort hierarchy flags (`has_parent`, `has_children`); `parent` and `sub_issues_summary` are optional relationship summaries, and `closed_by_pull_requests` summarizes the pull requests configu",
              "enum": [
                "get",
                "get_comments",
                "get_sub_issues",
                "get_parent",
                "get_labels"
              ]
            },
            "owner": {
              "type": "string",
              "description": "The owner of the repository"
            },
            "page": {
              "type": "number",
              "description": "Page number for pagination (min 1)",
              "minimum": 1
            },
            "perPage": {
              "type": "number",
              "description": "Results per page for pagination (min 1, max 100)",
              "minimum": 1,
              "maximum": 100
            },
            "repo": {
              "type": "string",
              "description": "The name of the repository"
            }
          },
          "additionalProperties": false,
          "required": [
            "method",
            "owner",
            "repo",
            "issue_number"
          ]
        },
        "schemaDigest": "sha256:bb45d3b1967cb45c2e1c8b6d8d7d6b7019b012f8ef695e045ced77970e1ac1ef",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.list_branches",
        "description": "저장소의 브랜치 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "owner": {
              "type": "string",
              "description": "Repository owner"
            },
            "page": {
              "type": "number",
              "description": "Page number for pagination (min 1)",
              "minimum": 1
            },
            "perPage": {
              "type": "number",
              "description": "Results per page for pagination (min 1, max 100)",
              "minimum": 1,
              "maximum": 100
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            }
          },
          "additionalProperties": false,
          "required": [
            "owner",
            "repo"
          ]
        },
        "schemaDigest": "sha256:6e344f10a92f17353653e5f75dc58cedd27c806848d0d4a7ea1d10fcc759f934",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.list_commits",
        "description": "브랜치의 커밋 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "author": {
              "type": "string",
              "description": "Author username or email address to filter commits by"
            },
            "fields": {
              "type": "array",
              "description": "Subset of fields to return for each commit. If omitted, all fields are returned. Use this to reduce response size when you only need specific fields, e.g. just 'sha' and 'html_url'.",
              "items": {
                "type": "string",
                "enum": [
                  "sha",
                  "html_url",
                  "commit",
                  "author",
                  "committer"
                ]
              }
            },
            "owner": {
              "type": "string",
              "description": "Repository owner"
            },
            "page": {
              "type": "number",
              "description": "Page number for pagination (min 1)",
              "minimum": 1
            },
            "path": {
              "type": "string",
              "description": "Only commits containing this file path will be returned"
            },
            "perPage": {
              "type": "number",
              "description": "Results per page for pagination (min 1, max 100)",
              "minimum": 1,
              "maximum": 100
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            },
            "sha": {
              "type": "string",
              "description": "Commit SHA, branch or tag name to list commits of. If not provided, uses the default branch of the repository. If a commit SHA is provided, will list commits up to that SHA."
            },
            "since": {
              "type": "string",
              "description": "Only commits after this date will be returned (ISO 8601 format: YYYY-MM-DDTHH:MM:SSZ or YYYY-MM-DD)"
            },
            "until": {
              "type": "string",
              "description": "Only commits before this date will be returned (ISO 8601 format: YYYY-MM-DDTHH:MM:SSZ or YYYY-MM-DD)"
            }
          },
          "additionalProperties": false,
          "required": [
            "owner",
            "repo"
          ]
        },
        "schemaDigest": "sha256:cef2ce2b00b456bd3e735e536a7fae9804ee60f06165a5f52dbdd026030867b9",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.list_issue_fields",
        "description": "이슈에 쓸 수 있는 사용자 지정 필드를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "owner": {
              "type": "string",
              "description": "The account owner of the repository or organization. The name is not case sensitive."
            },
            "repo": {
              "type": "string",
              "description": "The name of the repository. When provided, returns fields for this specific repository (inherited from its organization). When omitted, returns org-level fields directly."
            }
          },
          "additionalProperties": false,
          "required": [
            "owner"
          ]
        },
        "schemaDigest": "sha256:1c1c0c1869451c0e9a743adc17e4c414c012279f5871c2f0ac75ac0ac821aef7",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.list_issue_types",
        "description": "조직의 이슈 유형 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "owner": {
              "type": "string",
              "description": "The account owner of the repository or organization."
            },
            "repo": {
              "type": "string",
              "description": "The name of the repository. When provided, returns issue types for this specific repository. When omitted, returns org-level issue types directly."
            }
          },
          "additionalProperties": false,
          "required": [
            "owner"
          ]
        },
        "schemaDigest": "sha256:e2559c2dd7845c4b6b7768ca46fab6e7749024c427743f4645a28ad1b640b324",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.list_issues",
        "description": "저장소의 이슈 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "after": {
              "type": "string",
              "description": "Cursor for pagination. Use the cursor from the previous response."
            },
            "direction": {
              "type": "string",
              "description": "Order direction. If provided, the 'orderBy' also needs to be provided.",
              "enum": [
                "ASC",
                "DESC"
              ]
            },
            "field_filters": {
              "type": "array",
              "description": "Filter by custom issue field values. Each entry takes a field_name and a value; the server looks up the field and coerces the value to its type (single-select option name, text, number, or YYYY-MM-DD date).",
              "items": {
                "type": "object",
                "properties": {
                  "field_name": {
                    "type": "string",
                    "description": "Name of the custom field (e.g. \"Priority\"). Case-insensitive."
                  },
                  "value": {
                    "type": "string",
                    "description": "Value to filter on. For single-select fields, the option name (e.g. \"P1\"). For dates, YYYY-MM-DD. For numbers, the numeric value as a string. For text, the text value."
                  }
                },
                "additionalProperties": false,
                "required": [
                  "field_name",
                  "value"
                ]
              }
            },
            "fields": {
              "type": "array",
              "description": "Subset of fields to return for each issue. If omitted, all fields are returned. Use this to reduce response size when you only need specific fields; omitting 'body' and 'field_values' in particular drops the largest per-result data.",
              "items": {
                "type": "string",
                "enum": [
                  "number",
                  "title",
                  "body",
                  "state",
                  "user",
                  "labels",
                  "assignees",
                  "comments",
                  "created_at",
                  "updated_at",
                  "field_values"
                ]
              }
            },
            "labels": {
              "type": "array",
              "description": "Filter by labels",
              "items": {
                "type": "string"
              }
            },
            "orderBy": {
              "type": "string",
              "description": "Order issues by field. If provided, the 'direction' also needs to be provided.",
              "enum": [
                "CREATED_AT",
                "UPDATED_AT",
                "COMMENTS"
              ]
            },
            "owner": {
              "type": "string",
              "description": "Repository owner"
            },
            "perPage": {
              "type": "number",
              "description": "Results per page for pagination (min 1, max 100)",
              "minimum": 1,
              "maximum": 100
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            },
            "since": {
              "type": "string",
              "description": "Filter by date (ISO 8601 timestamp)"
            },
            "state": {
              "type": "string",
              "description": "Filter by state, by default both open and closed issues are returned when not provided",
              "enum": [
                "OPEN",
                "CLOSED"
              ]
            }
          },
          "additionalProperties": false,
          "required": [
            "owner",
            "repo"
          ]
        },
        "schemaDigest": "sha256:ca3273f487d55de1dbbccaffe7adb0c40b8fdb032777850c7fc081f497c4a7c2",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.list_pull_requests",
        "description": "저장소의 풀 리퀘스트 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "base": {
              "type": "string",
              "description": "Filter by base branch"
            },
            "direction": {
              "type": "string",
              "description": "Sort direction",
              "enum": [
                "asc",
                "desc"
              ]
            },
            "fields": {
              "type": "array",
              "description": "Subset of fields to return for each pull request. If omitted, all fields are returned. Use this to reduce response size when you only need specific fields; omitting 'body' in particular drops the largest per-result data.",
              "items": {
                "type": "string",
                "enum": [
                  "number",
                  "title",
                  "body",
                  "state",
                  "draft",
                  "merged",
                  "mergeable_state",
                  "html_url",
                  "user",
                  "labels",
                  "assignees",
                  "requested_reviewers",
                  "merged_by",
                  "head",
                  "base",
                  "additions",
                  "deletions",
                  "changed_files",
                  "commits",
                  "comments",
                  "created_at",
                  "updated_at",
                  "closed_at",
                  "merged_at",
                  "milestone"
                ]
              }
            },
            "head": {
              "type": "string",
              "description": "Filter by head user/org and branch"
            },
            "owner": {
              "type": "string",
              "description": "Repository owner"
            },
            "page": {
              "type": "number",
              "description": "Page number for pagination (min 1)",
              "minimum": 1
            },
            "perPage": {
              "type": "number",
              "description": "Results per page for pagination (min 1, max 100)",
              "minimum": 1,
              "maximum": 100
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            },
            "sort": {
              "type": "string",
              "description": "Sort by",
              "enum": [
                "created",
                "updated",
                "popularity",
                "long-running"
              ]
            },
            "state": {
              "type": "string",
              "description": "Filter by state",
              "enum": [
                "open",
                "closed",
                "all"
              ]
            }
          },
          "additionalProperties": false,
          "required": [
            "owner",
            "repo"
          ]
        },
        "schemaDigest": "sha256:1e4a27031225cf7f5847cc825132c6a1df76aaf2861651692731a9adfbf15969",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.list_releases",
        "description": "저장소의 릴리스 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "fields": {
              "type": "array",
              "description": "Subset of fields to return for each release. If omitted, all fields are returned. Use this to reduce response size when you only need specific fields; omitting 'body' in particular drops the largest per-release data.",
              "items": {
                "type": "string",
                "enum": [
                  "id",
                  "tag_name",
                  "name",
                  "body",
                  "html_url",
                  "published_at",
                  "prerelease",
                  "draft",
                  "author"
                ]
              }
            },
            "owner": {
              "type": "string",
              "description": "Repository owner"
            },
            "page": {
              "type": "number",
              "description": "Page number for pagination (min 1)",
              "minimum": 1
            },
            "perPage": {
              "type": "number",
              "description": "Results per page for pagination (min 1, max 100)",
              "minimum": 1,
              "maximum": 100
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            }
          },
          "additionalProperties": false,
          "required": [
            "owner",
            "repo"
          ]
        },
        "schemaDigest": "sha256:3959aa5544341ab62535466b81424cc02920a185968aad97f7849937641f6a2c",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.list_repository_collaborators",
        "description": "저장소 협업자 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "affiliation": {
              "type": "string",
              "description": "Filter by affiliation. Can be one of: 'outside' (outside collaborators), 'direct' (all with permissions regardless of org membership), 'all' (all collaborators). Default: 'all'",
              "enum": [
                "outside",
                "direct",
                "all"
              ]
            },
            "owner": {
              "type": "string",
              "description": "Repository owner"
            },
            "page": {
              "type": "number",
              "description": "Page number for pagination (default 1, min 1)",
              "minimum": 1
            },
            "perPage": {
              "type": "number",
              "description": "Results per page for pagination (default 30, min 1, max 100)",
              "minimum": 1,
              "maximum": 100
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            }
          },
          "additionalProperties": false,
          "required": [
            "owner",
            "repo"
          ]
        },
        "schemaDigest": "sha256:66f4f98a58926eec16279fffaf712ac5dde4a9d3f83c13a25d8c247483c02296",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.list_tags",
        "description": "저장소의 태그 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "owner": {
              "type": "string",
              "description": "Repository owner"
            },
            "page": {
              "type": "number",
              "description": "Page number for pagination (min 1)",
              "minimum": 1
            },
            "perPage": {
              "type": "number",
              "description": "Results per page for pagination (min 1, max 100)",
              "minimum": 1,
              "maximum": 100
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            }
          },
          "additionalProperties": false,
          "required": [
            "owner",
            "repo"
          ]
        },
        "schemaDigest": "sha256:5e529875cdc6612c50e4b78059ad99f4f47e9832fbd38802fc09b8fd437feba4",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.pull_request_read",
        "description": "풀 리퀘스트의 본문, 변경 파일, 리뷰, 상태 점검을 읽습니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "after": {
              "type": "string",
              "description": "Cursor for pagination, used only by the get_review_comments method. Pass the endCursor from the previous page's PageInfo to fetch the next page."
            },
            "method": {
              "type": "string",
              "description": "Action to specify what pull request data needs to be retrieved from GitHub. \nPossible options: \n 1. get - Get details of a specific pull request.\n 2. get_diff - Get the diff of a pull request.\n 3. get_status - Get combined commit status of a head commit in a pull request.\n 4. get_files - Get the lis",
              "enum": [
                "get",
                "get_diff",
                "get_status",
                "get_files",
                "get_commits",
                "get_review_comments",
                "get_reviews",
                "get_comments",
                "get_check_runs"
              ]
            },
            "owner": {
              "type": "string",
              "description": "Repository owner"
            },
            "page": {
              "type": "number",
              "description": "Page number for pagination (min 1)",
              "minimum": 1
            },
            "perPage": {
              "type": "number",
              "description": "Results per page for pagination (min 1, max 100)",
              "minimum": 1,
              "maximum": 100
            },
            "pullNumber": {
              "type": "number",
              "description": "Pull request number"
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            }
          },
          "additionalProperties": false,
          "required": [
            "method",
            "owner",
            "repo",
            "pullNumber"
          ]
        },
        "schemaDigest": "sha256:7d8f2b5cc8d1623ad13c73c5faf02aacdd274eb36706a932c30b3b1ca3fa449a",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.search_code",
        "description": "GitHub 전체에서 코드를 검색합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "fields": {
              "type": "array",
              "description": "Subset of fields to return for each code search result. If omitted, all fields are returned. Use this to reduce response size when you only need specific fields; omitting 'repository' and 'text_matches' in particular drops the largest per-result data.",
              "items": {
                "type": "string",
                "enum": [
                  "name",
                  "path",
                  "sha",
                  "repository",
                  "text_matches"
                ]
              }
            },
            "order": {
              "type": "string",
              "description": "Sort order for results",
              "enum": [
                "asc",
                "desc"
              ]
            },
            "page": {
              "type": "number",
              "description": "Page number for pagination (min 1)",
              "minimum": 1
            },
            "perPage": {
              "type": "number",
              "description": "Results per page for pagination (min 1, max 100)",
              "minimum": 1,
              "maximum": 100
            },
            "query": {
              "type": "string",
              "description": "Search query (GitHub code search REST). Implicit AND between terms; supports `OR`, `NOT`, and `\"quoted phrase\"` for exact match. Qualifiers: `repo:owner/repo`, `org:`, `user:`, `language:`, `path:dir` (prefix match), `filename:exact.ext`, `extension:`, `in:file`, `in:path`, `size:`, `is:archived`, `"
            },
            "sort": {
              "type": "string",
              "description": "Sort field ('indexed' only)"
            }
          },
          "additionalProperties": false,
          "required": [
            "query"
          ]
        },
        "schemaDigest": "sha256:53d40d8e4945257c6e83e97ae6507e773bfd67879793a321581c0c6f3d6379c8",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.search_commits",
        "description": "커밋을 검색합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "order": {
              "type": "string",
              "description": "Sort order",
              "enum": [
                "asc",
                "desc"
              ]
            },
            "page": {
              "type": "number",
              "description": "Page number for pagination (min 1)",
              "minimum": 1
            },
            "perPage": {
              "type": "number",
              "description": "Results per page for pagination (min 1, max 100)",
              "minimum": 1,
              "maximum": 100
            },
            "query": {
              "type": "string",
              "description": "Commit search query (GitHub commit search REST). Searches commit messages on the default branch only. Scope the search with `repo:owner/repo`, `org:`, or `user:` (queries without a scope qualifier match across all of GitHub and are usually not what you want). Other qualifiers: `author:`, `committer:"
            },
            "sort": {
              "type": "string",
              "description": "Sort by author or committer date (defaults to best match)",
              "enum": [
                "author-date",
                "committer-date"
              ]
            }
          },
          "additionalProperties": false,
          "required": [
            "query"
          ]
        },
        "schemaDigest": "sha256:8549387d500997f67df6f3e7dcd0533550d3741a102c759ce2598b6399321a61",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.search_issues",
        "description": "권한을 위임한 사용자가 접근할 수 있는 저장소에서 이슈를 검색합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "fields": {
              "type": "array",
              "description": "Subset of fields to return for each issue result. If omitted, all fields are returned. Use this to reduce response size when you only need specific fields; omitting 'body', 'reactions', and 'labels' in particular drops the largest per-result data.",
              "items": {
                "type": "string",
                "enum": [
                  "number",
                  "title",
                  "body",
                  "state",
                  "state_reason",
                  "draft",
                  "locked",
                  "html_url",
                  "user",
                  "author_association",
                  "labels",
                  "assignee",
                  "assignees",
                  "milestone",
                  "comments",
                  "reactions",
                  "created_at",
                  "updated_at",
                  "closed_at",
                  "closed_by",
                  "type",
                  "repository_url",
                  "pull_request",
                  "field_values"
                ]
              }
            },
            "order": {
              "type": "string",
              "description": "Sort order",
              "enum": [
                "asc",
                "desc"
              ]
            },
            "owner": {
              "type": "string",
              "description": "Optional repository owner. If provided with repo, only issues for this repository are listed."
            },
            "page": {
              "type": "number",
              "description": "Page number for pagination (min 1)",
              "minimum": 1
            },
            "perPage": {
              "type": "number",
              "description": "Results per page for pagination (min 1, max 100)",
              "minimum": 1,
              "maximum": 100
            },
            "query": {
              "type": "string",
              "description": "The search query, as natural language. When the user gives alternative wordings, include them as plain words rather than joining them with OR."
            },
            "repo": {
              "type": "string",
              "description": "Optional repository name. If provided with owner, only issues for this repository are listed."
            },
            "sort": {
              "type": "string",
              "description": "Sort field by number of matches of categories, defaults to best match",
              "enum": [
                "comments",
                "reactions",
                "reactions-+1",
                "reactions--1",
                "reactions-smile",
                "reactions-thinking_face",
                "reactions-heart",
                "reactions-tada",
                "interactions",
                "created",
                "updated"
              ]
            }
          },
          "additionalProperties": false,
          "required": [
            "query"
          ]
        },
        "schemaDigest": "sha256:c537a403feaf1a3a4b8c0ec15c663888b9b02c93244638a5299286c001eda7b7",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.search_pull_requests",
        "description": "풀 리퀘스트를 검색합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "fields": {
              "type": "array",
              "description": "Subset of fields to return for each pull request result. If omitted, all fields are returned. Use this to reduce response size when you only need specific fields; omitting 'body', 'reactions', and 'labels' in particular drops the largest per-result data.",
              "items": {
                "type": "string",
                "enum": [
                  "number",
                  "title",
                  "body",
                  "state",
                  "state_reason",
                  "draft",
                  "locked",
                  "html_url",
                  "user",
                  "author_association",
                  "labels",
                  "assignee",
                  "assignees",
                  "milestone",
                  "comments",
                  "reactions",
                  "created_at",
                  "updated_at",
                  "closed_at",
                  "closed_by",
                  "pull_request",
                  "repository_url"
                ]
              }
            },
            "order": {
              "type": "string",
              "description": "Sort order",
              "enum": [
                "asc",
                "desc"
              ]
            },
            "owner": {
              "type": "string",
              "description": "Optional repository owner. If provided with repo, only pull requests for this repository are listed."
            },
            "page": {
              "type": "number",
              "description": "Page number for pagination (min 1)",
              "minimum": 1
            },
            "perPage": {
              "type": "number",
              "description": "Results per page for pagination (min 1, max 100)",
              "minimum": 1,
              "maximum": 100
            },
            "query": {
              "type": "string",
              "description": "Search query using GitHub pull request search syntax"
            },
            "repo": {
              "type": "string",
              "description": "Optional repository name. If provided with owner, only pull requests for this repository are listed."
            },
            "sort": {
              "type": "string",
              "description": "Sort field by number of matches of categories, defaults to best match",
              "enum": [
                "comments",
                "reactions",
                "reactions-+1",
                "reactions--1",
                "reactions-smile",
                "reactions-thinking_face",
                "reactions-heart",
                "reactions-tada",
                "interactions",
                "created",
                "updated"
              ]
            }
          },
          "additionalProperties": false,
          "required": [
            "query"
          ]
        },
        "schemaDigest": "sha256:cdf7370cae2e5302761bea4a957a93c7e6fde6e90569f144fd646b2dd06d7334",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.search_repositories",
        "description": "저장소를 검색합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "minimal_output": {
              "type": "boolean",
              "description": "Return minimal repository information (default: true). When false, modern clients receive additional curated repository details, not the complete GitHub API object. Legacy clients retain full GitHub API repository objects."
            },
            "order": {
              "type": "string",
              "description": "Sort order",
              "enum": [
                "asc",
                "desc"
              ]
            },
            "page": {
              "type": "number",
              "description": "Page number for pagination (min 1)",
              "minimum": 1
            },
            "perPage": {
              "type": "number",
              "description": "Results per page for pagination (min 1, max 100)",
              "minimum": 1,
              "maximum": 100
            },
            "query": {
              "type": "string",
              "description": "Repository search query. Examples: 'machine learning in:name stars:>1000 language:python', 'topic:react', 'user:facebook'. Supports advanced search syntax for precise filtering."
            },
            "sort": {
              "type": "string",
              "description": "Sort repositories by field, defaults to best match",
              "enum": [
                "stars",
                "forks",
                "help-wanted-issues",
                "updated"
              ]
            }
          },
          "additionalProperties": false,
          "required": [
            "query"
          ]
        },
        "schemaDigest": "sha256:29b70ef802d4ad8615909c567c76d3f8ef3147e4a0b91299caa16c62c9f5d8e6",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.search_users",
        "description": "GitHub 사용자를 검색합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "order": {
              "type": "string",
              "description": "Sort order",
              "enum": [
                "asc",
                "desc"
              ]
            },
            "page": {
              "type": "number",
              "description": "Page number for pagination (min 1)",
              "minimum": 1
            },
            "perPage": {
              "type": "number",
              "description": "Results per page for pagination (min 1, max 100)",
              "minimum": 1,
              "maximum": 100
            },
            "query": {
              "type": "string",
              "description": "User search query. Examples: 'john smith', 'location:seattle', 'followers:>100'. Search is automatically scoped to type:user."
            },
            "sort": {
              "type": "string",
              "description": "Sort users by number of followers or repositories, or when the person joined GitHub.",
              "enum": [
                "followers",
                "repositories",
                "joined"
              ]
            }
          },
          "additionalProperties": false,
          "required": [
            "query"
          ]
        },
        "schemaDigest": "sha256:7c73811b6d3fddd204ea936cbdb6d1175b68675693873e382f4bcbb19a0d1cc1",
        "scopes": [
          "github:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "github.add_comment_to_pending_review",
        "description": "내 대기 중인 리뷰에 코멘트를 추가합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "body": {
              "type": "string",
              "description": "The text of the review comment"
            },
            "line": {
              "type": "number",
              "description": "The line of the blob in the pull request diff that the comment applies to. For multi-line comments, the last line of the range"
            },
            "owner": {
              "type": "string",
              "description": "Repository owner"
            },
            "path": {
              "type": "string",
              "description": "The relative path to the file that necessitates a comment"
            },
            "pullNumber": {
              "type": "number",
              "description": "Pull request number"
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            },
            "side": {
              "type": "string",
              "description": "The side of the diff to comment on. LEFT indicates the previous state, RIGHT indicates the new state",
              "enum": [
                "LEFT",
                "RIGHT"
              ]
            },
            "startLine": {
              "type": "number",
              "description": "For multi-line comments, the first line of the range that the comment applies to"
            },
            "startSide": {
              "type": "string",
              "description": "For multi-line comments, the starting side of the diff that the comment applies to. LEFT indicates the previous state, RIGHT indicates the new state",
              "enum": [
                "LEFT",
                "RIGHT"
              ]
            },
            "subjectType": {
              "type": "string",
              "description": "The level at which the comment is targeted",
              "enum": [
                "FILE",
                "LINE"
              ]
            }
          },
          "additionalProperties": false,
          "required": [
            "owner",
            "repo",
            "pullNumber",
            "path",
            "body",
            "subjectType"
          ]
        },
        "schemaDigest": "sha256:aed03ec6a0bf54dbe7d4cd7e93b3271e57bad8ed944f48ce1df8736249f382ad",
        "scopes": [
          "github:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "github.add_issue_comment",
        "description": "이슈 또는 풀 리퀘스트에 댓글을 남깁니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "body": {
              "type": "string",
              "description": "Comment content. Required unless reaction is provided.",
              "minLength": 1
            },
            "comment_id": {
              "type": "integer",
              "description": "The numeric ID of the issue or pull request comment to react to. Use this for reactions to comments; omit it to react to the issue or pull request itself. Cannot be combined with body.",
              "minimum": 1
            },
            "issue_number": {
              "type": "number",
              "description": "Issue or pull request number to comment on or react to."
            },
            "owner": {
              "type": "string",
              "description": "Repository owner"
            },
            "reaction": {
              "type": "string",
              "description": "Emoji reaction to add. Required unless body is provided.",
              "enum": [
                "+1",
                "-1",
                "laugh",
                "confused",
                "heart",
                "hooray",
                "rocket",
                "eyes"
              ]
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            }
          },
          "additionalProperties": false,
          "required": [
            "owner",
            "repo",
            "issue_number"
          ]
        },
        "schemaDigest": "sha256:5126668e1a1cb697e7e203f9ebaff1bb361fa1aeb423c5858b065aa32ba09c2f",
        "scopes": [
          "github:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "github.add_reply_to_pull_request_comment",
        "description": "풀 리퀘스트 리뷰 코멘트에 답글을 남깁니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "body": {
              "type": "string",
              "description": "The text of the reply. Required unless reaction is provided."
            },
            "commentId": {
              "type": "number",
              "description": "The numeric ID of the pull request review comment to reply or react to. Use the number from a #discussion_r... anchor, not the GraphQL thread node ID (PRRT_...).",
              "minimum": 1
            },
            "owner": {
              "type": "string",
              "description": "Repository owner"
            },
            "pullNumber": {
              "type": "number",
              "description": "Pull request number. Required when body is provided."
            },
            "reaction": {
              "type": "string",
              "description": "Emoji reaction to add. Required unless body is provided.",
              "enum": [
                "+1",
                "-1",
                "laugh",
                "confused",
                "heart",
                "hooray",
                "rocket",
                "eyes"
              ]
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            }
          },
          "additionalProperties": false,
          "required": [
            "owner",
            "repo",
            "commentId"
          ]
        },
        "schemaDigest": "sha256:a9fc2d2a8288044f62fcc71247b19c34982aaaccc70ec471047d8bd407fd6de8",
        "scopes": [
          "github:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "github.create_branch",
        "description": "저장소에 새 브랜치를 만듭니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "branch": {
              "type": "string",
              "description": "Name for new branch"
            },
            "from_branch": {
              "type": "string",
              "description": "Source branch (defaults to repo default)"
            },
            "owner": {
              "type": "string",
              "description": "Repository owner"
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            }
          },
          "additionalProperties": false,
          "required": [
            "owner",
            "repo",
            "branch"
          ]
        },
        "schemaDigest": "sha256:dac961e4b33c5224185ebb156bd4c5ab8922d7736533ad1d08caa6419e785497",
        "scopes": [
          "github:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "github.create_pull_request",
        "description": "풀 리퀘스트를 엽니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "base": {
              "type": "string",
              "description": "Branch to merge into"
            },
            "body": {
              "type": "string",
              "description": "PR description"
            },
            "draft": {
              "type": "boolean",
              "description": "Create as draft PR"
            },
            "head": {
              "type": "string",
              "description": "Branch containing changes"
            },
            "maintainer_can_modify": {
              "type": "boolean",
              "description": "Allow maintainer edits"
            },
            "owner": {
              "type": "string",
              "description": "Repository owner"
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            },
            "reviewers": {
              "type": "array",
              "description": "GitHub usernames or ORG/team-slug team reviewers to request reviews from",
              "items": {
                "type": "string"
              }
            },
            "title": {
              "type": "string",
              "description": "PR title"
            }
          },
          "additionalProperties": false,
          "required": [
            "owner",
            "repo",
            "title",
            "head",
            "base"
          ]
        },
        "schemaDigest": "sha256:17dbb4a6d18ce613943ce54ac938c1d477032e45cc95c32ee34c7a90fac96a4e",
        "scopes": [
          "github:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "github.issue_write",
        "description": "이슈를 만들거나 고칩니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "assignees": {
              "type": "array",
              "description": "Usernames to assign to this issue",
              "items": {
                "type": "string"
              }
            },
            "body": {
              "type": "string",
              "description": "Issue body content"
            },
            "duplicate_of": {
              "type": "number",
              "description": "Issue number that this issue is a duplicate of. Required when state_reason is 'duplicate'."
            },
            "issue_fields": {
              "type": "array",
              "description": "Issue field values to set or clear. Each item requires 'field_name' and exactly one of 'value', 'field_option_name', or 'delete: true'.",
              "items": {
                "type": "object",
                "properties": {
                  "delete": {
                    "type": "boolean",
                    "description": "Set to true to clear this field's current value on the issue. When false or omitted, this property is ignored. Cannot be true when 'value' or 'field_option_name' is provided."
                  },
                  "field_name": {
                    "type": "string",
                    "description": "Issue field name (case-insensitive). Must match a field returned by list_issue_fields for this repository or its organization."
                  },
                  "field_option_name": {
                    "type": "string",
                    "description": "Option name for single-select fields. Validated against the field's options before the API call. Cannot be combined with 'value' or 'delete: true'."
                  },
                  "value": {
                    "type": "string",
                    "description": "Value to set. Use for text, number, and date fields (date as YYYY-MM-DD). For single-select fields, prefer 'field_option_name' so the option is validated before the API call. Cannot be combined with 'field_option_name' or 'delete: true'."
                  }
                },
                "additionalProperties": false,
                "required": [
                  "field_name"
                ]
              }
            },
            "issue_number": {
              "type": "number",
              "description": "Issue number to update"
            },
            "labels": {
              "type": "array",
              "description": "Labels to apply to this issue",
              "items": {
                "type": "string"
              }
            },
            "method": {
              "type": "string",
              "description": "Write operation to perform on a single issue.\nOptions are:\n- 'create' - creates a new issue.\n- 'update' - updates an existing issue.\n",
              "enum": [
                "create",
                "update"
              ]
            },
            "milestone": {
              "type": "number",
              "description": "Milestone number"
            },
            "owner": {
              "type": "string",
              "description": "Repository owner"
            },
            "parent_issue_number": {
              "type": "number",
              "description": "Issue number of the parent issue. Only used when method is 'create' and cannot be combined with issue_fields. The new issue is created and attached to this parent in the same operation.",
              "minimum": 1
            },
            "parent_owner": {
              "type": "string",
              "description": "Repository owner of the parent issue. Must be provided with parent_repo. Omit both to use owner and repo. Only used when method is 'create' and parent_issue_number is provided."
            },
            "parent_repo": {
              "type": "string",
              "description": "Repository name of the parent issue. Must be provided with parent_owner. Omit both to use owner and repo. Only used when method is 'create' and parent_issue_number is provided."
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            },
            "state": {
              "type": "string",
              "description": "New state",
              "enum": [
                "open",
                "closed"
              ]
            },
            "state_reason": {
              "type": "string",
              "description": "Reason for the state change. Ignored unless state is changed.",
              "enum": [
                "completed",
                "not_planned",
                "duplicate"
              ]
            },
            "title": {
              "type": "string",
              "description": "Issue title"
            },
            "type": {
              "type": "string",
              "description": "Type of this issue. For updates, pass null to remove the current type. Only use if issue types are enabled for this repository. Use list_issue_types to get valid type values for this repository or its owner organization. If the repository doesn't support issue types, omit this parameter.",
              "minLength": 1
            }
          },
          "additionalProperties": false,
          "required": [
            "method",
            "owner",
            "repo"
          ]
        },
        "schemaDigest": "sha256:c8e80945ca4fcfd000896020117515fd7c9914bcc671f4c744ee0afbfcf6a769",
        "scopes": [
          "github:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "github.pull_request_review_write",
        "description": "풀 리퀘스트 리뷰를 만들고 제출합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "body": {
              "type": "string",
              "description": "Review comment text"
            },
            "commitID": {
              "type": "string",
              "description": "SHA of commit to review"
            },
            "event": {
              "type": "string",
              "description": "Review action to perform.",
              "enum": [
                "APPROVE",
                "REQUEST_CHANGES",
                "COMMENT"
              ]
            },
            "method": {
              "type": "string",
              "description": "The write operation to perform on pull request review.",
              "enum": [
                "create",
                "submit_pending",
                "delete_pending",
                "resolve_thread",
                "unresolve_thread"
              ]
            },
            "owner": {
              "type": "string",
              "description": "Repository owner"
            },
            "pullNumber": {
              "type": "number",
              "description": "Pull request number"
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            },
            "threadId": {
              "type": "string",
              "description": "The node ID of the review thread (e.g., PRRT_kwDOxxx). Required for resolve_thread and unresolve_thread methods. Get thread IDs from pull_request_read with method get_review_comments."
            }
          },
          "additionalProperties": false,
          "required": [
            "method",
            "owner",
            "repo",
            "pullNumber"
          ]
        },
        "schemaDigest": "sha256:a240efa89d83d302653e7b98f3dfab4fce6ad0c5bb9154208987927647f4b4ad",
        "scopes": [
          "github:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "github.sub_issue_write",
        "description": "하위 이슈를 추가하거나 순서를 바꿉니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "after_id": {
              "type": "number",
              "description": "The ID of the sub-issue to be prioritized after (either after_id OR before_id should be specified)"
            },
            "before_id": {
              "type": "number",
              "description": "The ID of the sub-issue to be prioritized before (either after_id OR before_id should be specified)"
            },
            "issue_number": {
              "type": "number",
              "description": "The number of the parent issue"
            },
            "method": {
              "type": "string",
              "description": "The action to perform on a single sub-issue\nOptions are:\n- 'add' - add a sub-issue to a parent issue in a GitHub repository.\n- 'remove' - remove a sub-issue from a parent issue in a GitHub repository.\n- 'reprioritize' - change the order of sub-issues within a parent issue in a GitHub repository. Use"
            },
            "owner": {
              "type": "string",
              "description": "Repository owner"
            },
            "replace_parent": {
              "type": "boolean",
              "description": "When true, replaces the sub-issue's current parent issue. Use with 'add' method only."
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            },
            "sub_issue_id": {
              "type": "number",
              "description": "The ID of the sub-issue to add. ID is not the same as issue number"
            }
          },
          "additionalProperties": false,
          "required": [
            "method",
            "owner",
            "repo",
            "issue_number",
            "sub_issue_id"
          ]
        },
        "schemaDigest": "sha256:2ae08e269bc6997f7457b0e06bbb2a40a1fc08ceb5bf2cc59cbf7b37eab13462",
        "scopes": [
          "github:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "github.update_issue_comment",
        "description": "내가 쓴 이슈 댓글을 고칩니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "body": {
              "type": "string",
              "description": "New comment content",
              "minLength": 1
            },
            "comment_id": {
              "type": "integer",
              "description": "The numeric ID of the issue or pull request conversation comment to update. Do not use a pull request review comment ID.",
              "minimum": 1
            },
            "owner": {
              "type": "string",
              "description": "Repository owner"
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            }
          },
          "additionalProperties": false,
          "required": [
            "owner",
            "repo",
            "comment_id",
            "body"
          ]
        },
        "schemaDigest": "sha256:7f1fbcab6b07b76e5d527306cbfacb960b5b768aa4b80ead87f01fbbb6372c2f",
        "scopes": [
          "github:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "github.update_pull_request",
        "description": "풀 리퀘스트의 제목, 본문, 상태를 고칩니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "base": {
              "type": "string",
              "description": "New base branch name"
            },
            "body": {
              "type": "string",
              "description": "New description"
            },
            "draft": {
              "type": "boolean",
              "description": "Mark pull request as draft (true) or ready for review (false)"
            },
            "maintainer_can_modify": {
              "type": "boolean",
              "description": "Allow maintainer edits"
            },
            "owner": {
              "type": "string",
              "description": "Repository owner"
            },
            "pullNumber": {
              "type": "number",
              "description": "Pull request number to update"
            },
            "repo": {
              "type": "string",
              "description": "Repository name"
            },
            "reviewers": {
              "type": "array",
              "description": "GitHub usernames or ORG/team-slug team reviewers to request reviews from",
              "items": {
                "type": "string"
              }
            },
            "state": {
              "type": "string",
              "description": "New state",
              "enum": [
                "open",
                "closed"
              ]
            },
            "title": {
              "type": "string",
              "description": "New title"
            }
          },
          "additionalProperties": false,
          "required": [
            "owner",
            "repo",
            "pullNumber"
          ]
        },
        "schemaDigest": "sha256:32db36cde729cda3d778050e1c27f370f11c5b1995493eb7c6774127d9504716",
        "scopes": [
          "github:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      }
    ]
  },
  "skill": {
    "reference": null,
    "optional": true
  },
  "momo": {
    "approvalTier": {
      "github.get_commit": "read_only",
      "github.get_file_contents": "read_only",
      "github.get_label": "read_only",
      "github.get_latest_release": "read_only",
      "github.get_me": "read_only",
      "github.get_release_by_tag": "read_only",
      "github.get_tag": "read_only",
      "github.get_team_members": "read_only",
      "github.get_teams": "read_only",
      "github.issue_read": "read_only",
      "github.list_branches": "read_only",
      "github.list_commits": "read_only",
      "github.list_issue_fields": "read_only",
      "github.list_issue_types": "read_only",
      "github.list_issues": "read_only",
      "github.list_pull_requests": "read_only",
      "github.list_releases": "read_only",
      "github.list_repository_collaborators": "read_only",
      "github.list_tags": "read_only",
      "github.pull_request_read": "read_only",
      "github.search_code": "read_only",
      "github.search_commits": "read_only",
      "github.search_issues": "read_only",
      "github.search_pull_requests": "read_only",
      "github.search_repositories": "read_only",
      "github.search_users": "read_only",
      "github.add_comment_to_pending_review": "network_write",
      "github.add_issue_comment": "network_write",
      "github.add_reply_to_pull_request_comment": "network_write",
      "github.create_branch": "network_write",
      "github.create_pull_request": "network_write",
      "github.issue_write": "network_write",
      "github.pull_request_review_write": "network_write",
      "github.sub_issue_write": "network_write",
      "github.update_issue_comment": "network_write",
      "github.update_pull_request": "network_write"
    },
    "risk": "medium",
    "egressDomains": [
      "api.githubcopilot.com"
    ],
    "recommendedFor": [
      "software-development",
      "work-tracking"
    ],
    "serverPolicy": {
      "installAllowed": true,
      "enabledByDefault": false,
      "allowedRoles": [
        "owner",
        "admin"
      ]
    }
  }
}
    $manifest$::jsonb
  ),
  (
    'com.momo.plugins.notion',
    '1.1.0',
    $manifest$
{
  "schemaVersion": "momo.plugin.v1",
  "plugin": {
    "id": "com.momo.plugins.notion",
    "name": "Notion",
    "version": "1.1.0",
    "description": "Official Notion hosted MCP integration",
    "publisher": {
      "id": "makenotion",
      "name": "Notion",
      "verified": true
    },
    "license": {
      "spdx": "MIT",
      "kind": "open_source"
    },
    "provenance": {
      "sourceURL": "https://github.com/makenotion/notion-mcp-server",
      "releaseRef": "hosted",
      "verified": true
    }
  },
  "mcp": {
    "protocolVersion": "2025-06-18",
    "transport": "streamable_http",
    "url": "https://mcp.notion.com/mcp",
    "server": {
      "name": "makenotion/notion-mcp-server",
      "version": "hosted"
    },
    "tools": [
      {
        "name": "notion.notion-search",
        "description": "권한을 위임한 사용자가 접근할 수 있는 페이지와 데이터베이스를 검색합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "Short, specific keywords for Notion content search. For user search, enter a name or email address. Provide a non-empty query unless intentionally browsing with filters or a non-relevance sort."
            },
            "query_type": {
              "type": "string",
              "description": "Specify type of the query as either \"internal\" or \"user\". Always include this input if performing \"user\" search.",
              "enum": [
                "internal",
                "user"
              ]
            },
            "data_source_url": {
              "type": "string",
              "description": "Optionally restrict keyword search to a data source URL returned in a <data-source> tag."
            },
            "page_url": {
              "type": "string",
              "description": "Optionally restrict keyword search to a page and its descendants. Accepts a Notion page URL or ID."
            },
            "teamspace_id": {
              "type": "string",
              "description": "Optionally, provide the ID of a teamspace to restrict search results to. This will perform a search over content within the specified teamspace only. Accepts the teamspace ID (UUIDv4) with or without dashes."
            },
            "filters": {
              "type": "object",
              "properties": {
                "created_date_range": {
                  "type": "object",
                  "properties": {
                    "start_date": {
                      "type": "string",
                      "description": "The start date of the date range as an ISO 8601 date string, if any."
                    },
                    "end_date": {
                      "type": "string",
                      "description": "The end date of the date range as an ISO 8601 date string, if any."
                    }
                  },
                  "additionalProperties": false
                },
                "created_by_user_ids": {
                  "type": "array",
                  "description": "Optional filter to only produce search results created by the Notion users that have the specified user IDs. Use \"me\" for the connected user.",
                  "items": {
                    "type": "string"
                  }
                },
                "edited_by_user_ids": {
                  "type": "array",
                  "description": "Optional filter to only produce search results edited by the Notion users that have the specified user IDs. Use \"me\" for the connected user. Available on the Business plan.",
                  "items": {
                    "type": "string"
                  }
                },
                "last_edited_date_range": {
                  "type": "object",
                  "properties": {
                    "start_date": {
                      "type": "string",
                      "description": "The start date of the date range as an ISO 8601 date string, if any."
                    },
                    "end_date": {
                      "type": "string",
                      "description": "The end date of the date range as an ISO 8601 date string, if any."
                    }
                  },
                  "additionalProperties": false
                },
                "teamspace_ids": {
                  "type": "array",
                  "description": "Optional filter to only produce search results inside one of the specified teamspaces. Selecting more than one teamspace is available on the Business plan; use teamspace_id for one teamspace on other plans.",
                  "items": {
                    "type": "string"
                  }
                },
                "title_only": {
                  "type": "boolean",
                  "description": "When true, match the query only against page and database titles instead of page content. Available on the Business plan."
                },
                "content_status": {
                  "type": "string",
                  "description": "Which pages to include by status. Omit for the default live pages. Supplying this field, even with the default value, requires Business access.",
                  "enum": [
                    "all_with_archived",
                    "all_without_archived",
                    "verified_only",
                    "archived_only"
                  ]
                }
              },
              "additionalProperties": false
            },
            "sort": {
              "type": "string",
              "description": "Result ordering for Notion workspace search. Omit for the default \"relevance\" ordering. \"last_edited\" and \"created\" require Business access.",
              "enum": [
                "relevance",
                "last_edited",
                "created"
              ]
            },
            "page_size": {
              "type": "integer",
              "description": "Maximum number of results to return (default 10). Lower values reduce response size.",
              "minimum": 1,
              "maximum": 50
            },
            "max_highlight_length": {
              "type": "integer",
              "description": "Maximum character length for result highlights (default 200). Set to 0 to omit highlights entirely.",
              "minimum": 0,
              "maximum": 500
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "query"
          ]
        },
        "schemaDigest": "sha256:32ede9db3020fb1004986e8de6161de53810d8841507d86a03925e02ad6ff007",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-memory-search",
        "description": "내 Notion 메모리를 검색합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "Words or a short phrase to find in personal memories.",
              "minLength": 1,
              "maxLength": 500
            },
            "limit": {
              "type": "integer",
              "description": "Maximum number of memories to return. Defaults to 10 and cannot exceed 50.",
              "minimum": 1,
              "maximum": 50
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "query"
          ]
        },
        "schemaDigest": "sha256:aaf0ece0c56bda8951257511c8f118132604ffdf0080777a0aa185f8f73526eb",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-fetch",
        "description": "페이지나 데이터베이스의 내용을 가져옵니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "The ID or URL of the Notion page, database, or data source to fetch. Supports notion.so URLs, Notion Sites URLs (*.notion.site), raw UUIDs, and data source URLs (collection://...). Pass \"memory\" to fetch the connected user's About page and memory database in this workspace without creating them. Pas"
            },
            "include_transcript": {
              "type": "boolean",
              "description": "Whether to include meeting note transcripts. Defaults to false. When true, full transcripts are included; when false, a placeholder with the meeting note URL is shown instead."
            },
            "include_discussions": {
              "type": "boolean",
              "description": "Whether to include discussion/comment indicators in the page output. When true, adds a <page-discussions> summary with discussion count, preview snippets, and discussion:// URLs. Use with the get_comments tool to retrieve full discussion content. Defaults to false."
            },
            "include_file_urls": {
              "type": "boolean",
              "description": "Whether to return signed download URLs for uploaded files. Defaults to false. When false, page Markdown cites uploaded files by stable notion-file-block:// references and the response has no references map; call get_file_download_urls with the references when you need those files' contents. When tru"
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "id"
          ]
        },
        "schemaDigest": "sha256:c0e02c4915f3494d815e4126357a90f8fe83aa7e9e50fb60e867fc85e82e9ab2",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-get-comments",
        "description": "페이지의 댓글과 토론을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "page_id": {
              "type": "string",
              "description": "Identifier for a Notion page."
            },
            "include_resolved": {
              "type": "boolean",
              "description": "Include resolved discussions in the response. Defaults to false."
            },
            "include_all_blocks": {
              "type": "boolean",
              "description": "Include discussions on child blocks, not just page-level discussions. Defaults to false."
            },
            "discussion_id": {
              "type": "string",
              "description": "Fetch a specific discussion by ID or discussion URL (e.g., discussion://pageId/blockId/discussionId)."
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "page_id"
          ]
        },
        "schemaDigest": "sha256:311143b065c3e0ce67ff1b3887404811206eef3b1b1e45953c76d4068f8c064e",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-get-teams",
        "description": "워크스페이스의 팀스페이스 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "Optional search query to filter teams by name (case-insensitive).",
              "minLength": 1,
              "maxLength": 100
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:56f871684cc8c832ce5831867301a736ecbae7a54c73331f7bef804e96b0d8fd",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-get-groups",
        "description": "워크스페이스의 사용자 그룹을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "Optional group name to search for (case-insensitive), or a group ID from a People property value (`space_permission_group-<id>` or the bare ID) to look up that group.",
              "minLength": 1,
              "maxLength": 100
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:16776e9d2e47f30e56ba458d01521f4e1aba3635168f526e489eb292d22141ce",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-get-users",
        "description": "워크스페이스 사용자 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "Optional search query to filter users by name or email (case-insensitive).",
              "minLength": 1,
              "maxLength": 100
            },
            "start_cursor": {
              "type": "string",
              "description": "Cursor for pagination. Use the next_cursor value from the previous response to get the next page.",
              "minLength": 1
            },
            "page_size": {
              "type": "integer",
              "description": "Number of users to return per page (1–100; default 100).",
              "minimum": 1,
              "maximum": 100
            },
            "user_id": {
              "type": "string",
              "description": "Return only the user matching this ID. Pass \"self\" to fetch the current user.",
              "minLength": 1,
              "maxLength": 100
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:f3289f785a61120cdcbe3e72108b61ddd5d6d882d05ca60a12a114638a0dfcc1",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-get-self",
        "description": "연결된 내 Notion 계정 정보를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:d2a9cfd71fb969b4edef232f6acf12bbe7cae94b815068e0ab2520d3d30ac1d7",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-get-async-task",
        "description": "비동기 작업의 진행 상태를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "task_id": {
              "type": "string",
              "description": "The ID of the async task to retrieve, as returned in the async_task response of the tool that started it.",
              "minLength": 1
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "task_id"
          ]
        },
        "schemaDigest": "sha256:cc3394f5f65987dac12cfb7d8c351814d10f33b229fe0f379b2b224ee790dc0b",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-get-file-download-urls",
        "description": "첨부 파일의 내려받기 주소를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "references": {
              "type": "array",
              "description": "Stable notion-file-block:// file references, copied exactly from the Markdown returned by fetch. Up to 25 per call.",
              "items": {
                "type": "string"
              }
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "references"
          ]
        },
        "schemaDigest": "sha256:7456013fcc00c26f44858a65938cd4f5498ecab6502e48d611b6becd29c10c2f",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-download-attachment",
        "description": "첨부 파일을 내려받습니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "file_upload_id": {
              "type": "string",
              "description": "The FileUpload ID returned by the create-attachment tool."
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "file_upload_id"
          ]
        },
        "schemaDigest": "sha256:6a5183d29c9e6e25a3e70dfd4f382e8c8da38b0f607547a038ae99491d518981",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-query-data-sources",
        "description": "데이터 소스를 조건으로 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "data": {
              "type": "object",
              "properties": {
                "data_source_urls": {
                  "type": "array",
                  "description": "Notion data source URLs whose SQLite tables are available to the query; each data source is exposed as a table named by its URL. Obtain them from the fetch tool, in the format: collection://f336d0bc-b841-465b-8045-024475c079dd",
                  "items": {
                    "type": "string"
                  }
                },
                "query": {
                  "type": "string",
                  "description": "Read-only SQLite query to execute against the data sources. Use a data source URL as the table name, e.g. SELECT * FROM \"collection://...\" WHERE .... Use only table and column names shown in the fetched `<sqlite-table>` definition; date properties use the expanded column names listed there, not the "
                },
                "mode": {
                  "type": "string",
                  "description": "Optional mode parameter. Defaults to 'sql' if not specified. SQL mode does not accept is_archived; that parameter belongs only to view mode.",
                  "enum": [
                    "sql"
                  ]
                },
                "params": {
                  "type": "array",
                  "description": "Positional parameters bound to `?` placeholders in the query. Prefer parameterized queries over string interpolation. Use \"__YES__\" for checked checkboxes and \"__NO__\" for unchecked checkboxes.",
                  "items": {
                    "type": "string"
                  }
                }
              },
              "additionalProperties": false,
              "required": [
                "data_source_urls",
                "query"
              ]
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "data"
          ]
        },
        "schemaDigest": "sha256:059191306422dbfdd017c25fd646b7b07ed82c295e2323f377af16d501529077",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-query-multiple-data-sources",
        "description": "여러 데이터 소스를 한 번에 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "Read-only SQLite query to execute against the data sources. Use a data source URL as the table name, e.g. SELECT * FROM \"collection://...\" WHERE .... Use only table and column names shown in the fetched `<sqlite-table>` definition; date properties use the expanded column names listed there, not the "
            },
            "data_source_urls": {
              "type": "array",
              "description": "Notion data source URLs whose SQLite tables are available to the query; each data source is exposed as a table named by its URL. Obtain them from the fetch tool, in the format: collection://f336d0bc-b841-465b-8045-024475c079dd",
              "items": {
                "type": "string"
              }
            },
            "params": {
              "type": "array",
              "description": "Positional parameters bound to `?` placeholders in the query. Prefer parameterized queries over string interpolation. Use \"__YES__\" for checked checkboxes and \"__NO__\" for unchecked checkboxes.",
              "items": {
                "type": "string"
              }
            },
            "mode": {
              "type": "string",
              "description": "Optional SQL mode marker. This tool only supports SQL queries.",
              "enum": [
                "sql"
              ]
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "query",
            "data_source_urls"
          ]
        },
        "schemaDigest": "sha256:9e7d3d47abb41d30b5fabb4c8399a6dde055e3afae1e7a45549ef67141b3796b",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-query-meeting-notes",
        "description": "회의록을 조건으로 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "filter": {
              "type": "object",
              "properties": {
                "operator": {
                  "type": "string",
                  "description": "Operator for combinator filters.",
                  "enum": [
                    "and",
                    "or"
                  ]
                },
                "filters": {
                  "type": "array",
                  "description": "Nested filters; each may be a combinator (and/or) or property filter.",
                  "items": {
                    "type": "object",
                    "properties": {
                      "property": {
                        "type": "string",
                        "description": "Which meeting-note property to filter on. Prefer the short names; the schema URI form is accepted for compatibility.",
                        "enum": [
                          "title",
                          "attendees",
                          "created_time",
                          "created_by",
                          "last_edited_time",
                          "last_edited_by",
                          "notion://meeting_notes/attendees"
                        ]
                      },
                      "filter": {
                        "type": "object",
                        "properties": {
                          "operator": {
                            "type": "string",
                            "description": "How to compare the text.",
                            "enum": [
                              "string_is",
                              "string_is_not",
                              "string_contains",
                              "string_does_not_contain",
                              "string_starts_with",
                              "string_ends_with"
                            ]
                          },
                          "value": {
                            "type": "object",
                            "properties": {
                              "type": {
                                "type": "string",
                                "description": "Always `exact`",
                                "enum": [
                                  "exact"
                                ]
                              },
                              "value": {
                                "type": "string",
                                "description": "The literal text the operator compares against."
                              }
                            },
                            "additionalProperties": false,
                            "required": [
                              "type",
                              "value"
                            ]
                          }
                        },
                        "additionalProperties": false,
                        "required": [
                          "operator",
                          "value"
                        ]
                      }
                    },
                    "additionalProperties": false,
                    "required": [
                      "property",
                      "filter"
                    ]
                  }
                }
              },
              "additionalProperties": false,
              "required": [
                "operator"
              ]
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:a18da0cf2c5ee430bd6a7559b9ae5a41ae20c598e6e636e6fae0afd526843000",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-list-private-pages",
        "description": "내 비공개 페이지 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "number",
              "description": "Maximum results to return (1-200)."
            },
            "cursor": {
              "type": "string",
              "description": "Opaque pagination cursor from the previous response."
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:4cbc16b5722b5c63a565beb5e1486c268c12f90f696da298ce4c77a077e23e98",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-list-shared-pages",
        "description": "나와 공유된 페이지 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "number",
              "description": "Maximum results to return (1-200)."
            },
            "cursor": {
              "type": "string",
              "description": "Opaque pagination cursor from the previous response."
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:bfd4af5b4196aaf03e6b5dca9300d07db87e7f6944ac6aeb702ff7cf36126655",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-list-favorite-pages",
        "description": "즐겨찾기 페이지 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "number",
              "description": "Maximum results to return (1-200)."
            },
            "cursor": {
              "type": "string",
              "description": "Opaque pagination cursor from the previous response."
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:f31514f4c7e4cc691bb039a6fa3778a18f1f14f05474311d47943882c5b03939",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-list-recent-pages",
        "description": "최근 페이지 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "number",
              "description": "Maximum results to return (1-200)."
            },
            "cursor": {
              "type": "string",
              "description": "Opaque pagination cursor from the previous response."
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:12122b35e08b860078ad0dce0f4c444aa90b86b6d2af653fb7aba2229b7b10d3",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-list-page-backlinks",
        "description": "페이지를 가리키는 링크 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "page_id": {
              "type": "string",
              "description": "ID or URL of the page or database to find backlinks for."
            },
            "types": {
              "type": "array",
              "description": "Only return these kinds of backlinks. page_mention is an inline @-mention in text, a title, or a caption; link_to_page is a link-to-page block; property_mention is a mention in a database property; comment_mention is a mention in a comment. Omit for all kinds.",
              "items": {
                "type": "string",
                "description": "One of: `page_mention`, `link_to_page`, `property_mention`, `comment_mention`",
                "enum": [
                  "page_mention",
                  "link_to_page",
                  "property_mention",
                  "comment_mention"
                ]
              }
            },
            "page_size": {
              "type": "integer",
              "description": "Maximum backlinks to return (1-100; default 25).",
              "minimum": 1,
              "maximum": 100
            },
            "cursor": {
              "type": "string",
              "description": "next_cursor from the previous call."
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "page_id"
          ]
        },
        "schemaDigest": "sha256:63fd72626902e3c1b640f8002317bd00b2c99ce9cbaa95471c569282ed8b2caa",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-calendar-list-calendars",
        "description": "Notion 캘린더 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "onlyAccountEmails": {
              "type": "array",
              "description": "Return only accounts linked to these email addresses. Useful to get calendars from a work account only for example. Do not specify if you are interested in getting the whole picture of someone's agenda across work and personal accounts.",
              "items": {
                "type": "string"
              }
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:59d68f465e951db0aba3a7e59613524f7080e6e3bbc65fdc74c1e54a01b06f37",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-calendar-list-events",
        "description": "Notion 캘린더의 일정을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "timeMin": {
              "type": "string",
              "description": "Start of the time range, as an ISO 8601 date-time."
            },
            "timeMax": {
              "type": "string",
              "description": "End of the time range, as an ISO 8601 date-time."
            },
            "timeZone": {
              "type": "string",
              "description": "Date-times of returned events will be expressed in this time-zone"
            },
            "includeDeclinedInvites": {
              "type": "boolean",
              "description": "Whether to include event invites the user has declined"
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "timeMin",
            "timeMax",
            "timeZone"
          ]
        },
        "schemaDigest": "sha256:e20da016076a073dab470314886731c51ab90a16cd0eb2bc853ff101a420c834",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-calendar-list-coworkers-events",
        "description": "동료의 일정을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "coworkerEmails": {
              "type": "array",
              "description": "Emails of relevant coworkers",
              "items": {
                "type": "string"
              }
            },
            "timeMin": {
              "type": "string",
              "description": "Start of the time range, as an ISO 8601 date-time."
            },
            "timeMax": {
              "type": "string",
              "description": "End of the time range, as an ISO 8601 date-time."
            },
            "timeZone": {
              "type": "string",
              "description": "Date-times of returned events will be expressed in this time-zone"
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "coworkerEmails",
            "timeMin",
            "timeMax",
            "timeZone"
          ]
        },
        "schemaDigest": "sha256:46e15d141921460b66846ad23f90f8e3be17b6e15f6126ebbc90b4be7898328c",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-calendar-list-calendar-resources",
        "description": "캘린더 자원(회의실 등)을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "timeSlots": {
              "type": "array",
              "description": "Specific time slots to check. Returns available resources for each time slot independently.",
              "items": {
                "type": "object",
                "properties": {
                  "startAt": {
                    "type": "string",
                    "description": "Start of the time slot to check, as an ISO 8601 date-time."
                  },
                  "endAt": {
                    "type": "string",
                    "description": "End of the time slot to check, as an ISO 8601 date-time."
                  }
                },
                "additionalProperties": false,
                "required": [
                  "startAt",
                  "endAt"
                ]
              }
            },
            "minCapacity": {
              "type": "integer",
              "description": "Minimum room capacity (number of people). MUST include the meeting organizer/user themselves in the count. For a 1-on-1, pass 2. For a meeting with N invitees besides the user, pass N+1.",
              "maximum": 9007199254740991
            },
            "maxCount": {
              "type": "integer",
              "description": "Maximum number of resources to return per time slot (default: 20, max: 40)",
              "maximum": 40
            },
            "ignoreWorkingLocation": {
              "type": "boolean",
              "description": "If true, do not narrow rooms to the user's working-location building for this day. Set this when the user is explicitly asking about rooms in a different office (e.g. for a visiting team)."
            },
            "timeZone": {
              "type": "string",
              "description": "Date-times of returned events will be expressed in this time-zone"
            },
            "calendar": {
              "type": "object",
              "properties": {
                "accountId": {
                  "type": "string",
                  "description": "Account that owns the target calendar."
                },
                "calendarId": {
                  "type": "string",
                  "description": "Target calendar identifier within the account."
                }
              },
              "additionalProperties": false,
              "required": [
                "accountId",
                "calendarId"
              ]
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "timeSlots",
            "minCapacity",
            "timeZone"
          ]
        },
        "schemaDigest": "sha256:f2fd1a39528143b391c83d1641722059485765894457bde9b9a39f9be090df8b",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-calendar-list-contacts",
        "description": "캘린더 연락처를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "queries": {
              "type": "array",
              "description": "Optional search queries to filter contacts by name or email. Results matching any query are included.",
              "items": {
                "type": "string"
              }
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:7b179ad9f6df82bbb22a5da9c9956cf0f38201f7254596cc63b61ed35247d2dc",
        "scopes": [
          "notion:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "notion.notion-create-pages",
        "description": "페이지를 새로 만듭니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "pages": {
              "type": "array",
              "description": "The pages to create.",
              "items": {
                "type": "object",
                "properties": {
                  "properties": {
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                  },
                  "content": {
                    "type": "string",
                    "description": "The content of the new page, using Notion Markdown. For people and dates, use user and date mentions rather than plain text; notion://docs/enhanced-markdown-spec gives the syntax."
                  },
                  "template_id": {
                    "type": "string",
                    "description": "The ID of a template to apply to this page. When specified, do not provide 'content' as the template will provide it. Properties can still be set alongside the template. Get template IDs from the <templates> section in the fetch tool results. Template application is asynchronous: the page starts bla"
                  },
                  "icon": {
                    "type": "string",
                    "description": "An emoji character (e.g. \"🚀\"), a custom emoji by name (e.g. \":rocket_ship:\"), a Notion icon identifier as returned by fetch (e.g. \"icons/pizza_blue\"), or an external image URL. Use \"none\" to explicitly set no icon. Omit to leave unchanged. Keep the title free of a duplicate leading emoji because the"
                  },
                  "cover": {
                    "type": "string",
                    "description": "An external image URL for the page cover. Use \"none\" to explicitly set no cover. Omit to leave unchanged."
                  },
                  "is_skill": {
                    "type": "boolean",
                    "description": "Set to true only when the user asks for reusable instructions or a repeatable workflow. Do not mark ordinary reference pages, one-time documents, or drafts as skills. Before creating a skill, read the MCP resource `notion://docs/skills` through your MCP client's resource-reading interface. If your c"
                  },
                  "preserve_internal_links": {
                    "type": "boolean",
                    "description": "Preserve internal Markdown links instead of converting them to native mentions."
                  }
                },
                "additionalProperties": false
              }
            },
            "creation_mode": {
              "type": "string",
              "description": "If the user explicitly names a private or shared destination, omit \"creation_mode\" and use that parent. Otherwise, use \"draft\" when the user clearly wants a durable page but has not named a destination. Prefer this explicit draft mode over omitting the parent. Draft mode is server-enforced: it creat",
              "enum": [
                "draft"
              ]
            },
            "parent": {
              "type": "string",
              "description": "Always `memory`",
              "enum": [
                "memory"
              ]
            },
            "allow_async": {
              "type": "boolean",
              "description": "Default to true for page creation. Set to false only when the next step needs the created pages immediately, or when async execution rejects the request as too large. When this create operation is accepted for background execution, it returns an async_task result. Use get_async_task to wait for a su"
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "pages"
          ]
        },
        "schemaDigest": "sha256:1ba4321fb87453f86c510d52cd7d3dcab60acaff9beb4900046ec79ff29e9f8c",
        "scopes": [
          "notion:write"
        ],
        "risk": "write",
        "approvalPolicy": "require_approval"
      },
      {
        "name": "notion.notion-create-database",
        "description": "데이터베이스를 새로 만듭니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "parent": {
              "type": "object",
              "properties": {
                "page_id": {
                  "type": "string",
                  "description": "The ID of the parent page, with or without dashes."
                },
                "type": {
                  "type": "string",
                  "description": "Always `page_id`",
                  "enum": [
                    "page_id"
                  ]
                }
              },
              "additionalProperties": false,
              "required": [
                "page_id"
              ]
            },
            "title": {
              "type": "string",
              "description": "The title of the new database."
            },
            "description": {
              "type": "string",
              "description": "The description of the new database."
            },
            "schema": {
              "type": "string",
              "description": "SQL DDL CREATE TABLE statement defining the database schema. Cannot be combined with database_type. Column names must be double-quoted and type options use single quotes.\n\nProperty type syntax:\n- Simple: TITLE, RICH_TEXT, DATE, PEOPLE, CHECKBOX, URL, EMAIL, PHONE_NUMBER, FILES\n- SELECT('opt':color, "
            },
            "database_type": {
              "type": "string",
              "description": "Create a canonical typed database with Notion's required properties and metadata. Supported types: tasks, projects, skills. Example: <example>tasks</example>. Use title \"Tasks\" when needed.",
              "enum": [
                "tasks",
                "projects",
                "skills"
              ]
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:511b781e23ca747bfa1b6ceeb17bb225d6c769f1fa8353f8269e5c4c05e9d48f",
        "scopes": [
          "notion:write"
        ],
        "risk": "write",
        "approvalPolicy": "require_approval"
      },
      {
        "name": "notion.notion-duplicate-page",
        "description": "페이지를 복제합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "page_id": {
              "type": "string",
              "description": "The ID of the page to duplicate. This is a v4 UUID, with or without dashes, and can be parsed from a Notion page URL."
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "page_id"
          ]
        },
        "schemaDigest": "sha256:fa25c291df042f27d2a5fb6bb77719f730e67ca679a9e59e3c871256b1e19c0f",
        "scopes": [
          "notion:write"
        ],
        "risk": "write",
        "approvalPolicy": "require_approval"
      },
      {
        "name": "notion.notion-create-view",
        "description": "데이터베이스 보기를 만듭니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "data_source_id": {
              "type": "string",
              "description": "The data source (collection) ID. Accepts a collection:// URI from <data-source> tags or a bare UUID."
            },
            "name": {
              "type": "string",
              "description": "The name of the view."
            },
            "type": {
              "type": "string",
              "description": "The type of view to create.",
              "enum": [
                "table",
                "board",
                "list",
                "calendar",
                "timeline",
                "gallery",
                "form",
                "chart",
                "map",
                "dashboard"
              ]
            },
            "database_id": {
              "type": "string",
              "description": "The database to add a view tab to. Accepts a Notion URL or a bare UUID. Mutually exclusive with `parent_page_id`; exactly one must be provided."
            },
            "parent_page_id": {
              "type": "string",
              "description": "A page to create an inline linked database view on, like the UI /linked command. Accepts a Notion URL or a bare UUID. The new linked view block is appended at the end of the page and references `data_source_id`. Mutually exclusive with `database_id`; exactly one must be provided."
            },
            "configure": {
              "type": "string",
              "description": "View configuration DSL directives and examples:\n- FILTER \"Property\" = \"value\" — filter rows. Relation values must be a page URL or UUID; person values must be a user URI (user://<user_id>), user UUID, or \"me\". Names are not supported for either.\n- QUICK FILTER \"Property\" — add a quick filter to the "
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "data_source_id",
            "name",
            "type"
          ]
        },
        "schemaDigest": "sha256:80cfeabd3619151b45b639181a82e1c056ab4bdc3f429b0e426f83feb89d8634",
        "scopes": [
          "notion:write"
        ],
        "risk": "write",
        "approvalPolicy": "require_approval"
      },
      {
        "name": "notion.notion-update-view",
        "description": "데이터베이스 보기를 고칩니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "view_id": {
              "type": "string",
              "description": "The view to update. Accepts a view:// URI, a Notion URL with ?v= parameter, or a bare UUID."
            },
            "name": {
              "type": "string",
              "description": "New name for the view."
            },
            "configure": {
              "type": "string",
              "description": "View configuration DSL string. Supports FILTER, QUICK FILTER, SORT BY, GROUP BY, SUB GROUP BY, CARD LAYOUT, CALENDAR BY, TIMELINE BY, MAP BY, CHART, FORM, SHOW, HIDE, COVER, WRAP CELLS, FREEZE COLUMNS, and CLEAR directives."
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "view_id"
          ]
        },
        "schemaDigest": "sha256:7e3e68962d2bbce0bb6da60a980aa76f97850f08f3cd495f599e257edf2b915d",
        "scopes": [
          "notion:write"
        ],
        "risk": "write",
        "approvalPolicy": "require_approval"
      },
      {
        "name": "notion.notion-create-folder",
        "description": "폴더를 만듭니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "parent": {
              "type": "object",
              "properties": {
                "page_id": {
                  "type": "string",
                  "description": "The ID of the page that will own the Folder."
                }
              },
              "additionalProperties": false,
              "required": [
                "page_id"
              ]
            },
            "title": {
              "type": "string",
              "description": "The title of the new Folder."
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "parent",
            "title"
          ]
        },
        "schemaDigest": "sha256:21e98db72b2ebd549f1a3ebba3cbc20593f25ef6679ce7b3da721c49b4665c0e",
        "scopes": [
          "notion:write"
        ],
        "risk": "write",
        "approvalPolicy": "require_approval"
      },
      {
        "name": "notion.notion-create-file-upload",
        "description": "파일 올리기를 시작합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "filename": {
              "type": "string",
              "description": "The filename to create in Notion, including a supported extension such as .pdf, .png, or .zip.",
              "minLength": 1
            },
            "content_type": {
              "type": "string",
              "description": "Optional MIME type, such as application/pdf or image/png. Prefer omitting it so the type is inferred from the filename: a type that disagrees with the extension is stored as given, and the file then renders as the wrong kind.",
              "minLength": 1,
              "maxLength": 255
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "filename"
          ]
        },
        "schemaDigest": "sha256:d79e8f323bce3e6eeea41418cd9d1b0cc00bca34b27618f56341529b0fb02e79",
        "scopes": [
          "notion:write"
        ],
        "risk": "write",
        "approvalPolicy": "require_approval"
      },
      {
        "name": "notion.notion-create-attachment",
        "description": "올린 파일을 페이지에 첨부합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "filename": {
              "type": "string",
              "description": "The filename to create in Notion, including a supported extension such as .html, .md, .pdf, or .png. Required with content and source_url. Omit it with source_file_id; the stored upload already carries a filename.",
              "minLength": 1
            },
            "content_type": {
              "type": "string",
              "description": "Optional MIME type, such as text/html or application/pdf. It must match the filename extension; omit it to infer the type from the filename. Omit it with source_file_id; the stored upload already carries a content type.",
              "minLength": 1,
              "maxLength": 255
            },
            "content": {
              "type": "string",
              "description": "The complete UTF-8 text content of the file. Maximum 200 KiB after UTF-8 encoding. Requires filename. Examples: <example><!doctype html><html><body><h1>Report</h1></body></html></example> or <example># Notes\n\nHello</example>.",
              "maxLength": 204800
            },
            "source_url": {
              "type": "string",
              "description": "A direct, publicly reachable HTTPS URL from which Notion can download the file within one minute. Notion makes a metadata-only HEAD request when supported, then a GET. Redirects, private network addresses, custom request headers, and cookies are not supported. Downloads are limited to 5 MiB for free",
              "minLength": 1,
              "maxLength": 8192
            },
            "source_file_id": {
              "type": "string",
              "description": "The ID of a file upload this exact integration already created. Use create_file_upload when available; otherwise run `ntn files create` or use the Notion File Upload API with this integration's token. Its status must be uploaded. An upload created with a different token is not visible. Example: <exa",
              "minLength": 1,
              "maxLength": 36
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:2746d5d9a931b55b9e192b3fe96ad667127b0649b62cb5bfdb9243c75ae25354",
        "scopes": [
          "notion:write"
        ],
        "risk": "write",
        "approvalPolicy": "require_approval"
      },
      {
        "name": "notion.notion-create-comment",
        "description": "페이지에 댓글을 남깁니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "page_id": {
              "type": "string",
              "description": "The ID of the page to comment on (with or without dashes)."
            },
            "reply_to_comment_id": {
              "type": "string",
              "description": "The ID of the comment to reply to."
            },
            "discussion_id": {
              "type": "string",
              "description": "The ID or URL of an existing discussion to reply to (e.g., discussion://pageId/blockId/discussionId)."
            },
            "selection_with_ellipsis": {
              "type": "string",
              "description": "Unique content snippet: ~10 characters from each end, joined by \"...\". A match within one block's text gets an inline comment on that text; otherwise, comment on the block where the match starts. No match returns an error."
            },
            "markdown": {
              "type": "string",
              "description": "The content of the comment as a Markdown string. Provide exactly one of markdown or rich_text. For exact syntax, read the MCP resource `notion://docs/enhanced-markdown-spec` through your MCP client's resource-reading interface, or call the Notion \"fetch\" tool with this URI if your client does not su"
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "page_id"
          ]
        },
        "schemaDigest": "sha256:a5539b36b52bd38ea426fd5b28dd83467ae6a71ddbfc38ae6d2a7e1011af9960",
        "scopes": [
          "notion:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "notion.notion-update-comment",
        "description": "내가 쓴 댓글을 고칩니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "comment_id": {
              "type": "string",
              "description": "The comment ID, with or without dashes. Use the id of a <comment> from get_comments, or the id returned by create_comment."
            },
            "markdown": {
              "type": "string",
              "description": "The full replacement text for the comment, as inline Markdown. It replaces the whole comment, so include any text you want to keep. Use the same inline syntax as create_comment. Lists, headings, and other block-level Markdown are not supported in comments."
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "comment_id",
            "markdown"
          ]
        },
        "schemaDigest": "sha256:9a19a7aabe5c7783a57eaea84c5322d1558d2046f3357a1d3e09ae8025eb3bee",
        "scopes": [
          "notion:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "notion.notion-set-discussion-resolved",
        "description": "토론을 해결됨으로 표시하거나 되돌립니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "discussion_id": {
              "type": "string",
              "description": "The discussion ID or URL, such as the id of a <discussion> from get_comments (discussion://pageId/blockId/discussionId) or the discussion_id returned by create_comment."
            },
            "resolved": {
              "type": "boolean",
              "description": "True to resolve the discussion, false to reopen it."
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "discussion_id",
            "resolved"
          ]
        },
        "schemaDigest": "sha256:b1afb87c0ed9f40cbe410719d5f94cecdd59b8c85e7d3d710537478112598f03",
        "scopes": [
          "notion:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "notion.notion-set-comment-reaction",
        "description": "댓글에 반응을 남기거나 지웁니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "comment_id": {
              "type": "string",
              "description": "The comment ID, with or without dashes. Use the id of a <comment> from get_comments, or the id returned by create_comment."
            },
            "emoji": {
              "type": "string",
              "description": "One standard Unicode emoji."
            },
            "reacted": {
              "type": "boolean",
              "description": "True to add the reaction, false to remove it."
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "comment_id",
            "emoji",
            "reacted"
          ]
        },
        "schemaDigest": "sha256:d68f843bcdb0a0015888f8a2cb48957e594308c71518087a8e7977b8e706dc9d",
        "scopes": [
          "notion:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "notion.notion-calendar-create-events",
        "description": "Notion 캘린더에 일정을 만듭니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "timeZone": {
              "type": "string",
              "description": "Date-times of returned events will be expressed in this time-zone"
            },
            "events": {
              "type": "array",
              "description": "Events to create.",
              "items": {
                "type": "object",
                "properties": {
                  "summary": {
                    "type": "string",
                    "description": "Title of the event.",
                    "minLength": 1
                  },
                  "description": {
                    "type": "string",
                    "description": "Description of the event."
                  },
                  "location": {
                    "type": "string",
                    "description": "Physical location where the event takes place, or remote conference link/info."
                  },
                  "recurrenceRules": {
                    "type": "array",
                    "description": "Recurrence rules in RRULE format (e.g., ['RRULE:FREQ=WEEKLY;COUNT=10']). Can also include EXDATE for exception dates (e.g., ['RRULE:FREQ=WEEKLY;COUNT=10', 'EXDATE:2026-03-24T13:00:00']).",
                    "items": {
                      "type": "string"
                    }
                  },
                  "period": {
                    "type": "object",
                    "properties": {
                      "type": {
                        "type": "string",
                        "description": "Whether the event period uses all-day dates or date-times.",
                        "enum": [
                          "DATE"
                        ]
                      },
                      "start": {
                        "type": "object",
                        "properties": {
                          "date": {
                            "type": "string",
                            "description": "Date in ISO 8601 format (no time)"
                          }
                        },
                        "additionalProperties": false,
                        "required": [
                          "date"
                        ]
                      },
                      "end": {
                        "type": "object",
                        "properties": {
                          "date": {
                            "type": "string",
                            "description": "Date in ISO 8601 format (no time)"
                          }
                        },
                        "additionalProperties": false,
                        "required": [
                          "date"
                        ]
                      }
                    },
                    "additionalProperties": false,
                    "required": [
                      "type",
                      "start",
                      "end"
                    ]
                  },
                  "attendees": {
                    "type": "array",
                    "description": "Attendees to invite to the event",
                    "items": {
                      "type": "object",
                      "properties": {
                        "email": {
                          "type": "string",
                          "description": "Email address of the attendee."
                        },
                        "displayName": {
                          "type": "string",
                          "description": "Totally optional, provide only if you are sure of the attendee's name"
                        },
                        "isOptional": {
                          "type": "boolean",
                          "description": "Set only if the user was explicit about an attendee not being required"
                        }
                      },
                      "additionalProperties": false,
                      "required": [
                        "email"
                      ]
                    }
                  },
                  "resources": {
                    "type": "array",
                    "description": "Resources (such as rooms) to invite to the event. Must be from the same account as `event.calendar`.",
                    "items": {
                      "type": "object",
                      "properties": {
                        "email": {
                          "type": "string",
                          "description": "Email address of the resource."
                        },
                        "displayName": {
                          "type": "string",
                          "description": "Display name of the resource."
                        },
                        "isOptional": {
                          "type": "boolean",
                          "description": "Set only if the user was explicit about a resource not being required"
                        }
                      },
                      "additionalProperties": false,
                      "required": [
                        "isOptional"
                      ]
                    }
                  },
                  "calendar": {
                    "type": "object",
                    "properties": {
                      "accountId": {
                        "type": "string",
                        "description": "Account that owns the target calendar."
                      },
                      "calendarId": {
                        "type": "string",
                        "description": "Target calendar identifier within the account."
                      }
                    },
                    "additionalProperties": false,
                    "required": [
                      "accountId",
                      "calendarId"
                    ]
                  },
                  "disableConferencing": {
                    "type": "boolean",
                    "description": "Whether to disable conferencing for this event."
                  }
                },
                "additionalProperties": false,
                "required": [
                  "summary",
                  "period"
                ]
              }
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "timeZone",
            "events"
          ]
        },
        "schemaDigest": "sha256:1800f8223fc8fe46f443d2c48afa6e518b513bfb2f3bc5fd138faefda8b1bb0a",
        "scopes": [
          "notion:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "notion.notion-calendar-update-events",
        "description": "Notion 캘린더의 일정을 고칩니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "timeZone": {
              "type": "string",
              "description": "Date-times of returned events will be expressed in this time-zone"
            },
            "updates": {
              "type": "array",
              "description": "Event updates to apply.",
              "items": {
                "type": "object",
                "properties": {
                  "updateType": {
                    "type": "string",
                    "description": "Must be set to the exact string \"RSVP\" in upper case.",
                    "enum": [
                      "RSVP"
                    ]
                  },
                  "event": {
                    "type": "object",
                    "properties": {
                      "calendar": {
                        "type": "object",
                        "properties": {
                          "accountId": {
                            "type": "string",
                            "description": "Account that owns the event calendar."
                          },
                          "calendarId": {
                            "type": "string",
                            "description": "Event calendar identifier within the account."
                          }
                        },
                        "additionalProperties": false,
                        "required": [
                          "accountId",
                          "calendarId"
                        ]
                      },
                      "eventId": {
                        "type": "string",
                        "description": "Identifier of the event to update."
                      },
                      "eventSummary": {
                        "type": "string",
                        "description": "Optional summary of the event, used by agent UI."
                      }
                    },
                    "additionalProperties": false,
                    "required": [
                      "calendar",
                      "eventId"
                    ]
                  },
                  "rsvp": {
                    "type": "object",
                    "properties": {
                      "responseStatus": {
                        "type": "string",
                        "description": "The calendar user's RSVP status",
                        "enum": [
                          "needsAction",
                          "accepted",
                          "declined",
                          "tentative"
                        ]
                      },
                      "comment": {
                        "type": "string",
                        "description": "Optional comment accompanying the RSVP."
                      }
                    },
                    "additionalProperties": false,
                    "required": [
                      "responseStatus"
                    ]
                  }
                },
                "additionalProperties": false,
                "required": [
                  "updateType",
                  "event",
                  "rsvp"
                ]
              }
            },
            "instructions_version": {
              "type": "string",
              "description": "Notion setup instructions version, such as 0.0.2. Omit if unknown."
            }
          },
          "additionalProperties": false,
          "required": [
            "timeZone",
            "updates"
          ]
        },
        "schemaDigest": "sha256:4c98b2bdb20efb7b4927396c314a9d7a6a048047f48804c95e78bd58cfd6bd09",
        "scopes": [
          "notion:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      }
    ]
  },
  "skill": {
    "reference": null,
    "optional": true
  },
  "momo": {
    "approvalTier": {
      "notion.notion-search": "read_only",
      "notion.notion-memory-search": "read_only",
      "notion.notion-fetch": "read_only",
      "notion.notion-get-comments": "read_only",
      "notion.notion-get-teams": "read_only",
      "notion.notion-get-groups": "read_only",
      "notion.notion-get-users": "read_only",
      "notion.notion-get-self": "read_only",
      "notion.notion-get-async-task": "read_only",
      "notion.notion-get-file-download-urls": "read_only",
      "notion.notion-download-attachment": "read_only",
      "notion.notion-query-data-sources": "read_only",
      "notion.notion-query-multiple-data-sources": "read_only",
      "notion.notion-query-meeting-notes": "read_only",
      "notion.notion-list-private-pages": "read_only",
      "notion.notion-list-shared-pages": "read_only",
      "notion.notion-list-favorite-pages": "read_only",
      "notion.notion-list-recent-pages": "read_only",
      "notion.notion-list-page-backlinks": "read_only",
      "notion.notion-calendar-list-calendars": "read_only",
      "notion.notion-calendar-list-events": "read_only",
      "notion.notion-calendar-list-coworkers-events": "read_only",
      "notion.notion-calendar-list-calendar-resources": "read_only",
      "notion.notion-calendar-list-contacts": "read_only",
      "notion.notion-create-pages": "network_write",
      "notion.notion-create-database": "network_write",
      "notion.notion-duplicate-page": "network_write",
      "notion.notion-create-view": "network_write",
      "notion.notion-update-view": "network_write",
      "notion.notion-create-folder": "network_write",
      "notion.notion-create-file-upload": "network_write",
      "notion.notion-create-attachment": "network_write",
      "notion.notion-create-comment": "network_write",
      "notion.notion-update-comment": "network_write",
      "notion.notion-set-discussion-resolved": "network_write",
      "notion.notion-set-comment-reaction": "network_write",
      "notion.notion-calendar-create-events": "network_write",
      "notion.notion-calendar-update-events": "network_write"
    },
    "risk": "medium",
    "egressDomains": [
      "mcp.notion.com"
    ],
    "recommendedFor": [
      "knowledge-management",
      "documentation"
    ],
    "serverPolicy": {
      "installAllowed": true,
      "enabledByDefault": false,
      "allowedRoles": [
        "owner",
        "admin"
      ]
    }
  }
}
    $manifest$::jsonb
  ),
  (
    'com.momo.plugins.linear',
    '1.1.0',
    $manifest$
{
  "schemaVersion": "momo.plugin.v1",
  "plugin": {
    "id": "com.momo.plugins.linear",
    "name": "Linear",
    "version": "1.1.0",
    "description": "Official Linear hosted MCP integration",
    "publisher": {
      "id": "linear",
      "name": "Linear",
      "verified": true
    },
    "license": {
      "spdx": "LicenseRef-Linear-Hosted-Service",
      "kind": "hosted_only"
    },
    "provenance": {
      "sourceURL": "https://linear.app/docs/mcp",
      "releaseRef": "hosted",
      "verified": true
    }
  },
  "mcp": {
    "protocolVersion": "2025-06-18",
    "transport": "streamable_http",
    "url": "https://mcp.linear.app/mcp",
    "server": {
      "name": "linear-hosted-mcp",
      "version": "hosted"
    },
    "tools": [
      {
        "name": "linear.get_attachment",
        "description": "이슈 첨부 하나를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "Issue attachment ID from get_issue's attachments array (attachments[].id)"
            },
            "format": {
              "type": "string",
              "description": "Omit or use content to fetch a Linear-hosted file. Use url for attachment metadata without fetching the file; also supports external links",
              "enum": [
                "content",
                "url"
              ]
            }
          },
          "additionalProperties": false,
          "required": [
            "id"
          ]
        },
        "schemaDigest": "sha256:51d2aa1a6c0f89d29e26876584b62da3d7eb3e0cbe1118ebbac3fa42ff5eb342",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.list_comments",
        "description": "이슈의 댓글 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "number",
              "description": "Maximum number of results to return per page",
              "maximum": 250
            },
            "cursor": {
              "type": "string",
              "description": "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true"
            },
            "orderBy": {
              "type": "string",
              "description": "Timestamp to sort results by: creation time or last update time",
              "enum": [
                "createdAt",
                "updatedAt"
              ]
            },
            "issueId": {
              "type": "string",
              "description": "Issue ID or identifier (e.g., LIN-123). P-prefixed identifiers (e.g., P-ENG-123) are projects, not issues (provide exactly one parent)"
            },
            "projectId": {
              "type": "string",
              "description": "Project name, ID, identifier (e.g., P-ENG-123), or slug (provide exactly one parent)"
            },
            "initiativeId": {
              "type": "string",
              "description": "Initiative name, ID, identifier (e.g., I-123), or slug (provide exactly one parent)"
            },
            "documentId": {
              "type": "string",
              "description": "Document ID or slug (provide exactly one parent)"
            },
            "milestoneId": {
              "type": "string",
              "description": "Milestone UUID (provide exactly one parent). Resolve milestone names via `list_milestones` first."
            },
            "statusUpdateId": {
              "type": "string",
              "description": "Status update UUID (provide exactly one parent). Resolve status updates via `get_status_updates` first."
            },
            "statusUpdateType": {
              "type": "string",
              "description": "Type of status update named by `statusUpdateId`, as returned by `get_status_updates`. Only valid together with `statusUpdateId`; omit to check both project and initiative status updates.",
              "enum": [
                "project",
                "initiative"
              ]
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:ca979b38500a2bedb69cce00af0c88636fbb71e59a58403853a57a0a2d6e5d3e",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.list_cycles",
        "description": "팀의 사이클 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "teamId": {
              "type": "string",
              "description": "Team UUID from list_teams or get_team; names and keys are not accepted"
            },
            "type": {
              "type": "string",
              "description": "Filter relative to the team's current cycle. Omit to return cycles without this filter",
              "enum": [
                "current",
                "previous",
                "next"
              ]
            }
          },
          "additionalProperties": false,
          "required": [
            "teamId"
          ]
        },
        "schemaDigest": "sha256:af3b1d1db662cca1620a428a53e99939fcc9a61ca37dfffa061c195cba26d1a1",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.list_custom_views",
        "description": "사용자 지정 보기 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "number",
              "description": "Maximum number of results to return per page",
              "maximum": 250
            },
            "cursor": {
              "type": "string",
              "description": "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true"
            },
            "orderBy": {
              "type": "string",
              "description": "Timestamp to sort results by: creation time or last update time",
              "enum": [
                "createdAt",
                "updatedAt"
              ]
            },
            "query": {
              "type": "string",
              "description": "Search custom view names"
            },
            "type": {
              "type": "string",
              "description": "Entity type displayed by the view",
              "enum": [
                "Issue",
                "Project",
                "Initiative"
              ]
            },
            "team": {
              "type": "string",
              "description": "Team name or ID"
            },
            "shared": {
              "type": "boolean",
              "description": "True for shared views, false for personal views"
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:9badae3b339c84b9c2f1a03d4b84c6dd8ab0a5f6f0d988683e71b3229c4ecc77",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.get_document",
        "description": "문서 하나를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "Document ID or slug"
            }
          },
          "additionalProperties": false,
          "required": [
            "id"
          ]
        },
        "schemaDigest": "sha256:4f9020a06a7e96e84301dd37a0b4915a9aa878cf499d28433c6926aedbb38c05",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.list_documents",
        "description": "문서 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "number",
              "description": "Maximum number of results to return per page",
              "maximum": 250
            },
            "cursor": {
              "type": "string",
              "description": "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true"
            },
            "orderBy": {
              "type": "string",
              "description": "Timestamp to sort results by: creation time or last update time",
              "enum": [
                "createdAt",
                "updatedAt"
              ]
            },
            "query": {
              "type": "string",
              "description": "Search query"
            },
            "projectId": {
              "type": "string",
              "description": "Filter by project ID, identifier (e.g., 'P-ENG-123'), or slug"
            },
            "initiativeId": {
              "type": "string",
              "description": "Filter by initiative ID, identifier (e.g., 'I-123'), or slug"
            },
            "teamId": {
              "type": "string",
              "description": "Filter by team ID"
            },
            "creatorId": {
              "type": "string",
              "description": "Filter by creator ID"
            },
            "createdAt": {
              "type": "string",
              "description": "Created after: ISO-8601 date/duration (e.g., -P1D)"
            },
            "updatedAt": {
              "type": "string",
              "description": "Updated after: ISO-8601 date/duration (e.g., -P1D)"
            },
            "includeArchived": {
              "type": "boolean",
              "description": "Include archived items"
            },
            "fields": {
              "type": "array",
              "description": "Fields to include in each result. Explicitly requested fields with no value return null. `id` is always included. Omit or pass an empty array for the default response.",
              "items": {
                "type": "string",
                "enum": [
                  "id",
                  "title",
                  "content",
                  "url",
                  "createdAt",
                  "updatedAt",
                  "archivedAt",
                  "creator",
                  "updatedBy",
                  "project",
                  "initiative",
                  "team",
                  "issue"
                ]
              }
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:76a753185aac37e5b0a39c1a2d5441ec8cf2d2174ea7dc752a1200de22eb8f44",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.extract_images",
        "description": "마크다운에서 이미지를 추출해 보여줍니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "markdown": {
              "type": "string",
              "description": "Markdown content containing image references (e.g., issue description, comment body)"
            }
          },
          "additionalProperties": false,
          "required": [
            "markdown"
          ]
        },
        "schemaDigest": "sha256:2f78fc50c1b294e9cdcb5c3978a57554cfd33272a4dbe298bc7917cfff7a8c8a",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.get_issue",
        "description": "이슈 하나를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "Issue ID or identifier (e.g., LIN-123). P-prefixed identifiers (e.g., P-ENG-123) are projects, not issues"
            },
            "fields": {
              "type": "array",
              "description": "Fields to include in each result. Explicitly requested fields with no value return null. `id` is always included. Omit or pass an empty array for the default response.",
              "items": {
                "type": "string",
                "enum": [
                  "id",
                  "uuid",
                  "title",
                  "description",
                  "projectMilestone",
                  "priority",
                  "estimate",
                  "url",
                  "gitBranchName",
                  "createdAt",
                  "updatedAt",
                  "archivedAt",
                  "completedAt",
                  "startedAt",
                  "canceledAt",
                  "startedTriageAt",
                  "triagedAt",
                  "dueDate",
                  "slaStartedAt",
                  "slaMediumRiskAt",
                  "slaHighRiskAt",
                  "slaBreachesAt",
                  "slaType",
                  "status",
                  "statusType",
                  "labels",
                  "triageIntel",
                  "createdBy",
                  "createdById",
                  "assignee",
                  "assigneeId",
                  "delegate",
                  "delegateId",
                  "project",
                  "projectId",
                  "parentId",
                  "team",
                  "teamId",
                  "cycleId",
                  "attachments",
                  "documents",
                  "stateHistory",
                  "relations",
                  "customerNeeds",
                  "releases"
                ]
              }
            },
            "includeRelations": {
              "type": "boolean",
              "description": "Include blocking/related/duplicate relations"
            },
            "includeCustomerNeeds": {
              "type": "boolean",
              "description": "Include associated customer needs"
            },
            "includeReleases": {
              "type": "boolean",
              "description": "Include associated releases"
            }
          },
          "additionalProperties": false,
          "required": [
            "id"
          ]
        },
        "schemaDigest": "sha256:204618cb73e84c71a76dead2483fb88cef440f35fd14a4af1656d05d0208a064",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.list_issues",
        "description": "권한을 위임한 사용자가 접근할 수 있는 이슈 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "number",
              "description": "Maximum number of results to return per page",
              "maximum": 250
            },
            "cursor": {
              "type": "string",
              "description": "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true"
            },
            "orderBy": {
              "type": "string",
              "description": "Timestamp to sort results by: creation time or last update time",
              "enum": [
                "createdAt",
                "updatedAt"
              ]
            },
            "query": {
              "type": "string",
              "description": "Search issue title or description. Cannot be combined with customView"
            },
            "customView": {
              "type": "string",
              "description": "Saved view ID, URL, slug, or exact name. Use list_custom_views to discover views. Applies saved filters and scope; other filters narrow the results. Uses list ordering, not saved display settings",
              "minLength": 1
            },
            "team": {
              "type": "string",
              "description": "Team name or ID"
            },
            "includeSubTeams": {
              "type": "boolean",
              "description": "Include results from the selected team and all descendants when team is set. Team ID filters already include descendants; this also expands name and key filters"
            },
            "state": {
              "type": "string",
              "description": "State type, name, or ID"
            },
            "cycle": {
              "type": "string",
              "description": "Cycle name, number, or ID"
            },
            "label": {
              "type": "string",
              "description": "Label name or ID"
            },
            "assignee": {
              "type": "string",
              "description": "User ID, name, email, or \"me\""
            },
            "creator": {
              "type": "string",
              "description": "User ID, name, email, or \"me\""
            },
            "delegate": {
              "type": "string",
              "description": "Agent name or ID. When the user asks to delegate to \"Linear\" or \"the Linear agent\", this refers to the \"Linear\" app user specifically"
            },
            "project": {
              "type": "string",
              "description": "Project name, ID, identifier (e.g., P-ENG-123), or slug"
            },
            "release": {
              "type": "string",
              "description": "Release ID or slug"
            },
            "priority": {
              "type": "number",
              "description": "0=None, 1=Urgent, 2=High, 3=Medium, 4=Low"
            },
            "parentId": {
              "type": "string",
              "description": "Parent issue ID or identifier (e.g., LIN-123)"
            },
            "fields": {
              "type": "array",
              "description": "Fields to include in each result. Explicitly requested fields with no value return null. `id` is always included. Omit or pass an empty array for the default response.",
              "items": {
                "type": "string",
                "enum": [
                  "id",
                  "uuid",
                  "title",
                  "description",
                  "projectMilestone",
                  "priority",
                  "estimate",
                  "url",
                  "gitBranchName",
                  "createdAt",
                  "updatedAt",
                  "archivedAt",
                  "completedAt",
                  "startedAt",
                  "canceledAt",
                  "startedTriageAt",
                  "triagedAt",
                  "dueDate",
                  "slaStartedAt",
                  "slaMediumRiskAt",
                  "slaHighRiskAt",
                  "slaBreachesAt",
                  "slaType",
                  "status",
                  "statusType",
                  "labels",
                  "triageIntel",
                  "createdBy",
                  "createdById",
                  "assignee",
                  "assigneeId",
                  "delegate",
                  "delegateId",
                  "project",
                  "projectId",
                  "parentId",
                  "team",
                  "teamId",
                  "cycleId"
                ]
              }
            },
            "createdAt": {
              "type": "string",
              "description": "Created after: ISO-8601 date/duration (e.g., -P1D)"
            },
            "updatedAt": {
              "type": "string",
              "description": "Updated after: ISO-8601 date/duration (e.g., -P1D)"
            },
            "triagedAt": {
              "type": "string",
              "description": "Left triage after: ISO-8601 date/duration (e.g., -P1D). Issues still in triage have no triagedAt; list them with state \"triage\""
            },
            "includeArchived": {
              "type": "boolean",
              "description": "Include archived items"
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:0a0b5943af7bf179341ab9c985aca28e553e2a141706770f79985c5b41f8c896",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.list_issue_statuses",
        "description": "팀의 이슈 상태 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "team": {
              "type": "string",
              "description": "Team name or ID"
            }
          },
          "additionalProperties": false,
          "required": [
            "team"
          ]
        },
        "schemaDigest": "sha256:0fe2e50f3badde0a16df5426f3c9b6341614b1a694ffd09e073b2ef2d2df4aa3",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.get_issue_status",
        "description": "이슈 상태 하나를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "Status ID"
            },
            "name": {
              "type": "string",
              "description": "Status name"
            },
            "team": {
              "type": "string",
              "description": "Team name or ID"
            }
          },
          "additionalProperties": false,
          "required": [
            "id",
            "name",
            "team"
          ]
        },
        "schemaDigest": "sha256:a004fa0c309cb3f9b26f393236d787dbb6a11c85afc335ca6edb429ebe017231",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.list_issue_labels",
        "description": "이슈 라벨 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "number",
              "description": "Maximum number of results to return per page",
              "maximum": 250
            },
            "cursor": {
              "type": "string",
              "description": "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true"
            },
            "orderBy": {
              "type": "string",
              "description": "Timestamp to sort results by: creation time or last update time",
              "enum": [
                "createdAt",
                "updatedAt"
              ]
            },
            "name": {
              "type": "string",
              "description": "Filter by name"
            },
            "team": {
              "type": "string",
              "description": "Team name or ID"
            },
            "includeArchived": {
              "type": "boolean",
              "description": "Include archived items"
            },
            "includeGroups": {
              "type": "boolean",
              "description": "Include label groups in the results, marked with `isGroup`. A group cannot be applied directly; retiring or restoring one cascades to its child labels"
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:be73df1187e371b957d964ef80b1e2f8a34d7742dbec3c60b2571f461ec68045",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.list_projects",
        "description": "프로젝트 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "number",
              "description": "Max results (default 50, max 50)",
              "maximum": 50
            },
            "cursor": {
              "type": "string",
              "description": "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true"
            },
            "orderBy": {
              "type": "string",
              "description": "Timestamp to sort results by: creation time or last update time",
              "enum": [
                "createdAt",
                "updatedAt"
              ]
            },
            "customView": {
              "type": "string",
              "description": "Saved view ID, URL, slug, or exact name. Use list_custom_views to discover views. Applies saved filters and scope; other filters narrow the results. Uses list ordering, not saved display settings",
              "minLength": 1
            },
            "query": {
              "type": "string",
              "description": "Search project name"
            },
            "state": {
              "type": "string",
              "description": "State type, name, or ID"
            },
            "initiative": {
              "type": "string",
              "description": "Initiative name, ID, identifier (e.g., I-123), or slug"
            },
            "team": {
              "type": "string",
              "description": "Team name or ID"
            },
            "includeSubTeams": {
              "type": "boolean",
              "description": "Include results from the selected team and all descendants when team is set. Team ID filters already include descendants; this also expands name and key filters"
            },
            "member": {
              "type": "string",
              "description": "User ID, name, email, or \"me\""
            },
            "label": {
              "type": "string",
              "description": "Label name or ID"
            },
            "createdAt": {
              "type": "string",
              "description": "Created after: ISO-8601 date/duration (e.g., -P1D)"
            },
            "updatedAt": {
              "type": "string",
              "description": "Updated after: ISO-8601 date/duration (e.g., -P1D)"
            },
            "includeMilestones": {
              "type": "boolean",
              "description": "Include milestones"
            },
            "includeMembers": {
              "type": "boolean",
              "description": "Include project members"
            },
            "includeArchived": {
              "type": "boolean",
              "description": "Include archived items"
            },
            "fields": {
              "type": "array",
              "description": "Fields to include in each result. Explicitly requested fields with no value return null. `id` is always included. Omit or pass an empty array for the default response.",
              "items": {
                "type": "string",
                "enum": [
                  "id",
                  "uuid",
                  "name",
                  "summary",
                  "description",
                  "url",
                  "trashed",
                  "createdAt",
                  "updatedAt",
                  "startedAt",
                  "completedAt",
                  "canceledAt",
                  "startDate",
                  "startDateResolution",
                  "targetDate",
                  "targetDateResolution",
                  "priority",
                  "sortOrder",
                  "labels",
                  "initiatives",
                  "lead",
                  "leadTeam",
                  "status",
                  "teams",
                  "members",
                  "milestones"
                ]
              }
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:30ffd3a21db3b8ba83edf263f1e0457d9046f2628651283a905c26f039321be2",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.get_project",
        "description": "프로젝트 하나를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "Project name, ID, identifier (e.g., P-ENG-123), or slug"
            },
            "includeCustomerNeeds": {
              "type": "boolean",
              "description": "Include one page of customer needs attached directly to the project"
            },
            "customerNeedsLimit": {
              "type": "integer",
              "description": "Customer needs per page when includeCustomerNeeds is true (default 10, max 50)",
              "minimum": 1,
              "maximum": 50
            },
            "customerNeedsCursor": {
              "type": "string",
              "description": "Next customer-needs page: pass customerNeedsPageInfo.endCursor with includeCustomerNeeds true"
            },
            "includeMilestones": {
              "type": "boolean",
              "description": "Include milestones"
            },
            "includeMembers": {
              "type": "boolean",
              "description": "Include project members"
            },
            "includeResources": {
              "type": "boolean",
              "description": "Include resources (documents, links, attachments)"
            }
          },
          "additionalProperties": false,
          "required": [
            "query"
          ]
        },
        "schemaDigest": "sha256:93d26ac5d3d713140cba47183703052b62106be1bf42703709b9e3ba116f0c4b",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.list_project_labels",
        "description": "프로젝트 라벨 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "number",
              "description": "Maximum number of results to return per page",
              "maximum": 250
            },
            "cursor": {
              "type": "string",
              "description": "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true"
            },
            "orderBy": {
              "type": "string",
              "description": "Timestamp to sort results by: creation time or last update time",
              "enum": [
                "createdAt",
                "updatedAt"
              ]
            },
            "name": {
              "type": "string",
              "description": "Filter by name"
            },
            "team": {
              "type": "string",
              "description": "Team name or ID"
            },
            "includeArchived": {
              "type": "boolean",
              "description": "Include archived items"
            },
            "includeGroups": {
              "type": "boolean",
              "description": "Include label groups in the results, marked with `isGroup`. A group cannot be applied directly; retiring or restoring one cascades to its child labels"
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:5cc644e1e1239bda0c7d1a0437b14f3442cf88e7f859aa26271acca64f040907",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.list_releases",
        "description": "릴리스 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "number",
              "description": "Maximum number of results to return per page",
              "maximum": 250
            },
            "cursor": {
              "type": "string",
              "description": "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true"
            },
            "orderBy": {
              "type": "string",
              "description": "Timestamp to sort results by: creation time or last update time",
              "enum": [
                "createdAt",
                "updatedAt"
              ]
            },
            "query": {
              "type": "string",
              "description": "Search release name or version"
            },
            "pipeline": {
              "type": "string",
              "description": "Release pipeline ID, slug, or exact name"
            },
            "stage": {
              "type": "string",
              "description": "Release stage ID or exact name"
            },
            "stageType": {
              "type": "string",
              "description": "Filter by stage lifecycle type",
              "enum": [
                "planned",
                "started",
                "completed",
                "canceled"
              ]
            },
            "version": {
              "type": "string",
              "description": "Exact version match"
            },
            "hasReleaseNotes": {
              "type": "boolean",
              "description": "Filter to releases that do (true) or do not (false) have release notes"
            },
            "includeReleaseNotes": {
              "type": "boolean",
              "description": "Include associated release notes"
            },
            "createdAt": {
              "type": "string",
              "description": "Created after: ISO-8601 date/duration (e.g., -P1D)"
            },
            "updatedAt": {
              "type": "string",
              "description": "Updated after: ISO-8601 date/duration (e.g., -P1D)"
            },
            "includeArchived": {
              "type": "boolean",
              "description": "Include archived items"
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:ba2aa7a20b80db2a01f8586bd3f12decce2c3c34a48347c9ccb0fdab0481dc25",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.get_release",
        "description": "릴리스 하나를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "Release ID or slug"
            },
            "includeReleaseNotes": {
              "type": "boolean",
              "description": "Include associated release notes"
            }
          },
          "additionalProperties": false,
          "required": [
            "id"
          ]
        },
        "schemaDigest": "sha256:f071839872d426c279903e116555a81f582a6a9107fe1e49ece538b534c09762",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.list_release_notes",
        "description": "릴리스 노트 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "number",
              "description": "Maximum number of results to return per page",
              "maximum": 250
            },
            "cursor": {
              "type": "string",
              "description": "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true"
            },
            "orderBy": {
              "type": "string",
              "description": "Timestamp to sort results by: creation time or last update time",
              "enum": [
                "createdAt",
                "updatedAt"
              ]
            },
            "query": {
              "type": "string",
              "description": "Search release notes title"
            },
            "pipeline": {
              "type": "string",
              "description": "Release pipeline ID, slug, or exact name"
            },
            "release": {
              "type": "string",
              "description": "Release ID or slug"
            },
            "includeContent": {
              "type": "boolean",
              "description": "Include markdown release notes content"
            },
            "includeReleases": {
              "type": "boolean",
              "description": "Include associated releases"
            },
            "createdAt": {
              "type": "string",
              "description": "Created after: ISO-8601 date/duration (e.g., -P1D)"
            },
            "updatedAt": {
              "type": "string",
              "description": "Updated after: ISO-8601 date/duration (e.g., -P1D)"
            },
            "includeArchived": {
              "type": "boolean",
              "description": "Include archived items"
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:79553d531cc32a3a13d3ab59266738cbe55727302063f9449f966a987492f851",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.get_release_note",
        "description": "릴리스 노트 하나를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "Release notes ID or slug"
            },
            "includeReleases": {
              "type": "boolean",
              "description": "Include associated releases"
            }
          },
          "additionalProperties": false,
          "required": [
            "id"
          ]
        },
        "schemaDigest": "sha256:a94961df82cca6731d24284a0b2a6576ffa5370a652425ac261fe33e3be3ebd5",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.list_release_pipelines",
        "description": "릴리스 파이프라인 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "number",
              "description": "Maximum number of results to return per page",
              "maximum": 250
            },
            "cursor": {
              "type": "string",
              "description": "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true"
            },
            "orderBy": {
              "type": "string",
              "description": "Timestamp to sort results by: creation time or last update time",
              "enum": [
                "createdAt",
                "updatedAt"
              ]
            },
            "query": {
              "type": "string",
              "description": "Search pipeline name"
            },
            "team": {
              "type": "string",
              "description": "Team name or ID"
            },
            "type": {
              "type": "string",
              "description": "Pipeline type: continuous | scheduled",
              "enum": [
                "continuous",
                "scheduled"
              ]
            },
            "isProduction": {
              "type": "boolean",
              "description": "Filter by production pipeline flag"
            },
            "includeStages": {
              "type": "boolean",
              "description": "Include each pipeline's stages"
            },
            "includeTeams": {
              "type": "boolean",
              "description": "Include each pipeline's teams"
            },
            "createdAt": {
              "type": "string",
              "description": "Created after: ISO-8601 date/duration (e.g., -P1D)"
            },
            "updatedAt": {
              "type": "string",
              "description": "Updated after: ISO-8601 date/duration (e.g., -P1D)"
            },
            "includeArchived": {
              "type": "boolean",
              "description": "Include archived items"
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:12de7a99d820446c54192192dadaba956f95091135aded557d7c4a172d4f4d05",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.list_milestones",
        "description": "프로젝트 마일스톤 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "project": {
              "type": "string",
              "description": "Project name, ID, identifier (e.g., P-ENG-123), or slug"
            }
          },
          "additionalProperties": false,
          "required": [
            "project"
          ]
        },
        "schemaDigest": "sha256:96d340a7330d9a5b98aaa7956f1f385215b63e841c39834d3144bbc7ed1b8914",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.get_milestone",
        "description": "마일스톤 하나를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "project": {
              "type": "string",
              "description": "Project name, ID, identifier (e.g., P-ENG-123), or slug"
            },
            "query": {
              "type": "string",
              "description": "Milestone name or ID"
            }
          },
          "additionalProperties": false,
          "required": [
            "project",
            "query"
          ]
        },
        "schemaDigest": "sha256:0e361b29840b930a2b00f507a511fbe6e923859f18177c14c36a72b29b1031e7",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.get_notifications",
        "description": "내 알림 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "number",
              "description": "Maximum number of results to return per page",
              "maximum": 250
            },
            "cursor": {
              "type": "string",
              "description": "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true"
            },
            "unreadOnly": {
              "type": "boolean",
              "description": "Only return unread notifications"
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:8425c8bba671e3dff04167cdd9fe85d096ec120a030a89dc85f565cd40e39f05",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.list_teams",
        "description": "워크스페이스의 팀 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "number",
              "description": "Maximum number of results to return per page",
              "maximum": 250
            },
            "cursor": {
              "type": "string",
              "description": "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true"
            },
            "orderBy": {
              "type": "string",
              "description": "Timestamp to sort results by: creation time or last update time",
              "enum": [
                "createdAt",
                "updatedAt"
              ]
            },
            "query": {
              "type": "string",
              "description": "Search query"
            },
            "parentTeam": {
              "type": "string",
              "description": "Only direct sub-teams of this team (name, key, or ID)"
            },
            "ancestorTeam": {
              "type": "string",
              "description": "All descendant teams of this team, at any depth, excluding itself (name, key, or ID)"
            },
            "includeArchived": {
              "type": "boolean",
              "description": "Include archived items"
            },
            "createdAt": {
              "type": "string",
              "description": "Created after: ISO-8601 date/duration (e.g., -P1D)"
            },
            "updatedAt": {
              "type": "string",
              "description": "Updated after: ISO-8601 date/duration (e.g., -P1D)"
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:db8672bb5ad0e5c1cd55986df6f9a70ea5cc35e611b05ba8a733d119aea4f0c7",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.get_team",
        "description": "팀 하나를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "Team UUID, key, or name"
            }
          },
          "additionalProperties": false,
          "required": [
            "query"
          ]
        },
        "schemaDigest": "sha256:960225f4ee2a0ed499b67c7b37b31ba8555e64440655533cd668fd66953d169a",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.get_triage_responsibility",
        "description": "팀의 분류 담당 설정을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "team": {
              "type": "string",
              "description": "Team name or ID"
            },
            "user": {
              "type": "string",
              "description": "Only return shifts of this user: User ID, name, email, or \"me\""
            },
            "limit": {
              "type": "integer",
              "description": "Max upcoming shifts to return (default 10, max 50)",
              "minimum": 1,
              "maximum": 50
            }
          },
          "additionalProperties": false,
          "required": [
            "team"
          ]
        },
        "schemaDigest": "sha256:1ee360a242cc4c5621f4452210db1346fc4b08f993badfb5440de0c84ab7dce7",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.list_templates",
        "description": "템플릿 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "description": "Filter by template type. Omit to return every type",
              "enum": [
                "issue",
                "project",
                "document"
              ]
            },
            "team": {
              "type": "string",
              "description": "Team name or ID. Returns that team's templates plus workspace-level ones"
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:f6679dec102f4be78b3cf1664ef299f9e52a776e7c984c4dea427e9deb91f9bc",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.get_template",
        "description": "템플릿 하나를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "Template ID or name"
            }
          },
          "additionalProperties": false,
          "required": [
            "id"
          ]
        },
        "schemaDigest": "sha256:ccabd6a03774ae21c34452d3d401f9aba20c18b40b60721de68a38194d2843cf",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.list_users",
        "description": "워크스페이스 사용자 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "number",
              "description": "Maximum number of results to return per page",
              "maximum": 250
            },
            "cursor": {
              "type": "string",
              "description": "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true"
            },
            "orderBy": {
              "type": "string",
              "description": "Timestamp to sort results by: creation time or last update time",
              "enum": [
                "createdAt",
                "updatedAt"
              ]
            },
            "query": {
              "type": "string",
              "description": "Match part of a name or email. Omit to list users without a name or email filter"
            },
            "team": {
              "type": "string",
              "description": "Team name or ID. Only return members of this team; omit to search the workspace"
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:3ce371fa20439789f90e398182f9bfcbbe0ec1f3b5ce05b4e04ac4ffbf82dcc4",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.get_user",
        "description": "사용자 한 명을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "User ID, name, email, or \"me\""
            }
          },
          "additionalProperties": false,
          "required": [
            "query"
          ]
        },
        "schemaDigest": "sha256:9b54eb2190d9fdf22293603947728ddf1a5472db6a3c8f13a94366add428f042",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.get_workspace",
        "description": "워크스페이스 정보를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {},
          "additionalProperties": false
        },
        "schemaDigest": "sha256:cbf36726b236741099543a5afab98359c207bdc8192325564d38a60d61f67d00",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.search_documentation",
        "description": "Linear 도움말 문서를 검색합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "Feature name, topic, or question to search for in Linear's product documentation"
            },
            "page": {
              "type": "number",
              "description": "Zero-based page number. Increment by one to fetch the next page for the same query"
            }
          },
          "additionalProperties": false,
          "required": [
            "query"
          ]
        },
        "schemaDigest": "sha256:034a5fd74ac92e0d1e582bccb5a7b387f06d77ffd42f9e29ffdea54e01ee8f1c",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.get_status_updates",
        "description": "프로젝트·이니셔티브 상태 업데이트를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "limit": {
              "type": "number",
              "description": "Maximum number of results to return per page",
              "maximum": 250
            },
            "cursor": {
              "type": "string",
              "description": "Omit for the first page. To continue, pass the previous response's cursor when hasNextPage is true"
            },
            "orderBy": {
              "type": "string",
              "description": "Timestamp to sort results by: creation time or last update time",
              "enum": [
                "createdAt",
                "updatedAt"
              ]
            },
            "type": {
              "type": "string",
              "description": "Type of status update",
              "enum": [
                "project",
                "initiative"
              ]
            },
            "id": {
              "type": "string",
              "description": "Update ID from get_status_updates results (statusUpdates[].id) or save_status_update's id"
            },
            "project": {
              "type": "string",
              "description": "Project name, ID, identifier (e.g., P-ENG-123), or slug. Filters project updates only; omit to include all accessible projects"
            },
            "initiative": {
              "type": "string",
              "description": "Initiative name, ID, identifier (e.g., I-123), or slug. Filters initiative updates only; omit to include all accessible initiatives"
            },
            "user": {
              "type": "string",
              "description": "Filter by update author: User ID, name, email, or \"me\". Omit to include all authors"
            },
            "createdAt": {
              "type": "string",
              "description": "Created after: ISO-8601 date/duration (e.g., -P1D)"
            },
            "updatedAt": {
              "type": "string",
              "description": "Updated after: ISO-8601 date/duration (e.g., -P1D)"
            },
            "includeArchived": {
              "type": "boolean",
              "description": "Include archived items"
            }
          },
          "additionalProperties": false,
          "required": [
            "type"
          ]
        },
        "schemaDigest": "sha256:89504860804575fee0cc4f886aa6cca58e11c0b811fdf1f3211b4a2029a9b34a",
        "scopes": [
          "linear:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "linear.mark_notification",
        "description": "내 알림을 읽음 처리하거나 되돌립니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "Notification ID"
            },
            "read": {
              "type": "boolean",
              "description": "Whether the notification should be marked as read"
            },
            "snoozedUntilAt": {
              "type": "string",
              "description": "ISO-8601 time to snooze until, or null to unsnooze"
            }
          },
          "additionalProperties": false,
          "required": [
            "id"
          ]
        },
        "schemaDigest": "sha256:6d6f9646b655d65023859db7afd59cac19acaf6a76e69bff7df5b5e70b65b76a",
        "scopes": [
          "linear:write"
        ],
        "risk": "write",
        "approvalPolicy": "require_approval"
      },
      {
        "name": "linear.save_comment",
        "description": "이슈에 댓글을 만들거나 고칩니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "Comment ID. If provided, updates the existing comment"
            },
            "issueId": {
              "type": "string",
              "description": "Issue ID or identifier (e.g., LIN-123). P-prefixed identifiers (e.g., P-ENG-123) are projects, not issues (provide exactly one parent)"
            },
            "projectId": {
              "type": "string",
              "description": "Project name, ID, identifier (e.g., P-ENG-123), or slug (provide exactly one parent)"
            },
            "initiativeId": {
              "type": "string",
              "description": "Initiative name, ID, identifier (e.g., I-123), or slug (provide exactly one parent)"
            },
            "documentId": {
              "type": "string",
              "description": "Document ID or slug (provide exactly one parent)"
            },
            "milestoneId": {
              "type": "string",
              "description": "Milestone UUID (provide exactly one parent). Resolve milestone names via `list_milestones` first."
            },
            "statusUpdateId": {
              "type": "string",
              "description": "Status update UUID (provide exactly one parent). Resolve status updates via `get_status_updates` first."
            },
            "statusUpdateType": {
              "type": "string",
              "description": "Type of status update named by `statusUpdateId`, as returned by `get_status_updates`. Only valid together with `statusUpdateId`; omit to check both project and initiative status updates.",
              "enum": [
                "project",
                "initiative"
              ]
            },
            "parentId": {
              "type": "string",
              "description": "Parent comment ID (for replies, only when creating)"
            },
            "body": {
              "type": "string",
              "description": "Content as Markdown. Do not escape the string — use literal newlines and special characters, not escape sequences. To mention a user, use @displayName (e.g., @johndoe)"
            }
          },
          "additionalProperties": false,
          "required": [
            "body"
          ]
        },
        "schemaDigest": "sha256:3746e07755fccacaa22c05e893e28be7688da58f67f4f3fe7e86069ae2a72b30",
        "scopes": [
          "linear:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "linear.save_issue",
        "description": "이슈를 만들거나 고칩니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "Only for updating an existing issue. Pass the issue ID or identifier (e.g., LIN-123). Do NOT pass this parameter when creating a new issue."
            },
            "title": {
              "type": "string",
              "description": "Issue title (required when creating, unless template is set)"
            },
            "description": {
              "type": "string",
              "description": "Content as Markdown. Do not escape the string — use literal newlines and special characters, not escape sequences. To mention a user, use @displayName (e.g., @johndoe)"
            },
            "patch": {
              "type": "array",
              "description": "Partial edits applied to the current content, in order and atomically (one failing operation aborts the whole save). Every anchor string must match the current content exactly once. Only valid on update, in place of the full content/description field",
              "items": {
                "type": "object",
                "properties": {
                  "op": {
                    "type": "string"
                  },
                  "old_string": {
                    "type": "string",
                    "description": "Exact text to replace. Must match the current content exactly once",
                    "minLength": 1
                  },
                  "new_string": {
                    "type": "string",
                    "description": "Replacement text. Empty string deletes the match"
                  },
                  "replace_all": {
                    "type": "boolean",
                    "description": "Replace every occurrence instead of requiring a unique match"
                  }
                },
                "additionalProperties": false,
                "required": [
                  "op",
                  "old_string",
                  "new_string"
                ]
              }
            },
            "team": {
              "type": "string",
              "description": "Team name or ID (required when creating)"
            },
            "template": {
              "type": "string",
              "description": "Template name or ID. Applied on create only. The template fills in the content, fields, and sub-issues server-side. A `description` replaces the template body rather than merging with it, but an empty `description` keeps the template body. Labels merge with the template's own"
            },
            "cycle": {
              "type": "string",
              "description": "Cycle name, number, or ID. Null to remove"
            },
            "milestone": {
              "type": "string",
              "description": "Milestone name or ID"
            },
            "priority": {
              "type": "number",
              "description": "0=None, 1=Urgent, 2=High, 3=Medium, 4=Low"
            },
            "project": {
              "type": "string",
              "description": "Project name, ID, identifier (e.g., P-ENG-123), or slug. Null to remove"
            },
            "state": {
              "type": "string",
              "description": "State type, name, or ID"
            },
            "assignee": {
              "type": "string",
              "description": "User ID, name, email, or \"me\". Null to remove"
            },
            "delegate": {
              "type": "string",
              "description": "Agent name or ID. When the user asks to delegate to \"Linear\" or \"the Linear agent\", this refers to the \"Linear\" app user specifically. Null to remove"
            },
            "labels": {
              "type": "array",
              "description": "Label names or IDs as a JSON array of strings (e.g. [\"Bug\", \"Urgent\"]). Replaces the full label set; existing labels not included are removed. Omit to leave labels unchanged. Cannot be combined with addLabels/removeLabels; prefer those for incremental changes",
              "items": {
                "type": "string"
              }
            },
            "addLabels": {
              "type": "array",
              "description": "Label names or IDs as a JSON array of strings (e.g. [\"Bug\", \"Urgent\"]) to add. Append-only; existing labels are never removed. Cannot be combined with a team change",
              "items": {
                "type": "string"
              }
            },
            "removeLabels": {
              "type": "array",
              "description": "Label names or IDs as a JSON array of strings (e.g. [\"Bug\", \"Urgent\"]) to remove. Only valid when updating an existing issue. Cannot be combined with a team change",
              "items": {
                "type": "string"
              }
            },
            "dueDate": {
              "type": "string",
              "description": "Due date (ISO format). On update, pass null to remove the due date"
            },
            "slaBreachesAt": {
              "type": "string",
              "description": "ISO-8601 timestamp when the SLA will breach. On update, pass null to remove the SLA"
            },
            "slaType": {
              "type": "string",
              "description": "SLA day counting type: \"all\" or \"onlyBusinessDays\". Only use with slaBreachesAt; null means unset",
              "enum": [
                "all",
                "onlyBusinessDays"
              ]
            },
            "parentId": {
              "type": "string",
              "description": "Parent issue ID or identifier (e.g., LIN-123). Null to remove"
            },
            "estimate": {
              "type": "number",
              "description": "Issue estimate value. On create, pass null or omit for no estimate. On update, pass null to clear the estimate; omitting leaves it unchanged. 0 is a real estimate only on teams that allow zero estimates."
            },
            "links": {
              "type": "array",
              "description": "Link attachments to add [{url, title}]. Append-only; existing links are never removed",
              "items": {
                "type": "object",
                "properties": {
                  "url": {
                    "type": "string"
                  },
                  "title": {
                    "type": "string",
                    "minLength": 1
                  }
                },
                "additionalProperties": false,
                "required": [
                  "url",
                  "title"
                ]
              }
            },
            "setReleases": {
              "type": "array",
              "description": "Replace all releases on the issue with these. Cannot be combined with addReleases/removeReleases",
              "items": {
                "type": "string"
              }
            },
            "addReleases": {
              "type": "array",
              "description": "Release IDs or slugs to add. Append-only; existing releases are never removed",
              "items": {
                "type": "string"
              }
            },
            "removeReleases": {
              "type": "array",
              "description": "Release IDs or slugs to remove. Only valid when updating an existing issue",
              "items": {
                "type": "string"
              }
            },
            "blocks": {
              "type": "array",
              "description": "Issue IDs/identifiers this blocks. Append-only; existing relations are never removed",
              "items": {
                "type": "string"
              }
            },
            "blockedBy": {
              "type": "array",
              "description": "Issue IDs/identifiers blocking this. Append-only; existing relations are never removed",
              "items": {
                "type": "string"
              }
            },
            "relatedTo": {
              "type": "array",
              "description": "Related issue IDs/identifiers. Append-only; existing relations are never removed",
              "items": {
                "type": "string"
              }
            },
            "duplicateOf": {
              "type": "string",
              "description": "Duplicate of issue ID/identifier. Null to remove"
            },
            "removeBlocks": {
              "type": "array",
              "description": "Issue IDs/identifiers to stop blocking",
              "items": {
                "type": "string"
              }
            },
            "removeBlockedBy": {
              "type": "array",
              "description": "Issue IDs/identifiers to remove as blockers of this issue",
              "items": {
                "type": "string"
              }
            },
            "removeRelatedTo": {
              "type": "array",
              "description": "Related issue IDs/identifiers to remove",
              "items": {
                "type": "string"
              }
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:a64f5db99b5946929adf422dedc7f5e11b81efba3a24a2f27256f17e57a14851",
        "scopes": [
          "linear:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "linear.save_project",
        "description": "프로젝트를 만들거나 고칩니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "Project name, ID, identifier (e.g., P-ENG-123), or slug. If provided, updates the existing project"
            },
            "name": {
              "type": "string",
              "description": "Project name (required when creating)"
            },
            "template": {
              "type": "string",
              "description": "Template name or ID. Applied on create only. The template fills in the content, fields, and sub-issues server-side. A `description` replaces the template body rather than merging with it, but an empty `description` keeps the template body. Labels merge with the template's own"
            },
            "icon": {
              "type": "string",
              "description": "Icon name or emoji code (e.g. \"Rocket\" or \":eagle:\"), not a raw Unicode emoji"
            },
            "color": {
              "type": "string",
              "description": "Hex color"
            },
            "summary": {
              "type": "string",
              "description": "Short summary (max 255 chars)"
            },
            "description": {
              "type": "string",
              "description": "Content as Markdown. Do not escape the string — use literal newlines and special characters, not escape sequences. To mention a user, use @displayName (e.g., @johndoe)"
            },
            "patch": {
              "type": "array",
              "description": "Partial edits applied to the current content, in order and atomically (one failing operation aborts the whole save). Every anchor string must match the current content exactly once. Only valid on update, in place of the full content/description field",
              "items": {
                "type": "object",
                "properties": {
                  "op": {
                    "type": "string"
                  },
                  "old_string": {
                    "type": "string",
                    "description": "Exact text to replace. Must match the current content exactly once",
                    "minLength": 1
                  },
                  "new_string": {
                    "type": "string",
                    "description": "Replacement text. Empty string deletes the match"
                  },
                  "replace_all": {
                    "type": "boolean",
                    "description": "Replace every occurrence instead of requiring a unique match"
                  }
                },
                "additionalProperties": false,
                "required": [
                  "op",
                  "old_string",
                  "new_string"
                ]
              }
            },
            "state": {
              "type": "string",
              "description": "Project status name, type, or ID. Names resolve within the lead team's project statuses. If the lead team is unknown, standard labels resolve as status types; custom names require a status ID or leadTeam"
            },
            "startDate": {
              "type": "string",
              "description": "Start date (ISO format). Pair with startDateResolution to indicate precision (e.g. month, quarter). Null to remove"
            },
            "startDateResolution": {
              "type": "string",
              "description": "Start date resolution. Null for an exact day. When omitted, the current resolution stays and the date snaps to it",
              "enum": [
                "halfYear",
                "month",
                "quarter",
                "year"
              ]
            },
            "targetDate": {
              "type": "string",
              "description": "Target date (ISO format). Pair with targetDateResolution to indicate precision (e.g. month, quarter). Null to remove"
            },
            "targetDateResolution": {
              "type": "string",
              "description": "Target date resolution. Null for an exact day. When omitted, the current resolution stays and the date snaps to it",
              "enum": [
                "halfYear",
                "month",
                "quarter",
                "year"
              ]
            },
            "priority": {
              "type": "integer",
              "description": "0=None, 1=Urgent, 2=High, 3=Medium, 4=Low",
              "minimum": 0,
              "maximum": 4
            },
            "addTeams": {
              "type": "array",
              "description": "Team name or ID to add",
              "items": {
                "type": "string"
              }
            },
            "removeTeams": {
              "type": "array",
              "description": "Team name or ID to remove",
              "items": {
                "type": "string"
              }
            },
            "setTeams": {
              "type": "array",
              "description": "Replace all teams with these. Cannot combine with addTeams/removeTeams",
              "items": {
                "type": "string"
              }
            },
            "leadTeam": {
              "type": "string",
              "description": "Team that leads the project. Team name or ID. Overrides the default lead team; added to the project's teams when not among them"
            },
            "labels": {
              "type": "array",
              "description": "Label names or IDs as a JSON array of strings (e.g. [\"Bug\", \"Urgent\"]). Replaces the full label set; existing labels not included are removed. Omit to leave labels unchanged",
              "items": {
                "type": "string"
              }
            },
            "lead": {
              "type": "string",
              "description": "User ID, name, email, or \"me\". Null to remove, except on create with a template that names a lead"
            },
            "addInitiatives": {
              "type": "array",
              "description": "Initiatives to add. Initiative name, ID, identifier (e.g., I-123), or slug",
              "items": {
                "type": "string"
              }
            },
            "removeInitiatives": {
              "type": "array",
              "description": "Initiatives to remove. Initiative name, ID, identifier (e.g., I-123), or slug",
              "items": {
                "type": "string"
              }
            },
            "setInitiatives": {
              "type": "array",
              "description": "Replace all initiatives with these. Initiative name, ID, identifier (e.g., I-123), or slug. Cannot combine with addInitiatives/removeInitiatives",
              "items": {
                "type": "string"
              }
            },
            "links": {
              "type": "array",
              "description": "External resource links to add [{url, title}]. Append-only; existing links are never removed",
              "items": {
                "type": "object",
                "properties": {
                  "url": {
                    "type": "string"
                  },
                  "title": {
                    "type": "string",
                    "minLength": 1
                  }
                },
                "additionalProperties": false,
                "required": [
                  "url",
                  "title"
                ]
              }
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:367cad16dfb43ebab9ec1249c58de08b0e812b54dd390016b30ea06d3a858a6e",
        "scopes": [
          "linear:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "linear.save_document",
        "description": "문서를 만들거나 고칩니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "Document ID or slug to update. Omit to create a new document."
            },
            "title": {
              "type": "string",
              "description": "Document title (required when creating)"
            },
            "content": {
              "type": "string",
              "description": "Content as Markdown. Do not escape the string — use literal newlines and special characters, not escape sequences. To mention a user, use @displayName (e.g., @johndoe)"
            },
            "patch": {
              "type": "array",
              "description": "Partial edits applied to the current content, in order and atomically (one failing operation aborts the whole save). Every anchor string must match the current content exactly once. Only valid on update, in place of the full content/description field",
              "items": {
                "type": "object",
                "properties": {
                  "op": {
                    "type": "string"
                  },
                  "old_string": {
                    "type": "string",
                    "description": "Exact text to replace. Must match the current content exactly once",
                    "minLength": 1
                  },
                  "new_string": {
                    "type": "string",
                    "description": "Replacement text. Empty string deletes the match"
                  },
                  "replace_all": {
                    "type": "boolean",
                    "description": "Replace every occurrence instead of requiring a unique match"
                  }
                },
                "additionalProperties": false,
                "required": [
                  "op",
                  "old_string",
                  "new_string"
                ]
              }
            },
            "project": {
              "type": "string",
              "description": "Project name, ID, identifier (e.g., P-ENG-123), or slug"
            },
            "issue": {
              "type": "string",
              "description": "Issue ID or identifier (e.g., LIN-123). P-prefixed identifiers (e.g., P-ENG-123) are projects, not issues"
            },
            "initiative": {
              "type": "string",
              "description": "Initiative name, ID, identifier (e.g., I-123), or slug"
            },
            "cycle": {
              "type": "string",
              "description": "Cycle name, number, or ID. When passing a name or number, also pass `team` to disambiguate."
            },
            "team": {
              "type": "string",
              "description": "Team name or ID. Attaches the document to the team, unless `cycle` is also passed, in which case it disambiguates the cycle."
            },
            "icon": {
              "type": "string",
              "description": "Icon name or emoji code (e.g. \"Rocket\" or \":eagle:\"), not a raw Unicode emoji"
            },
            "color": {
              "type": "string",
              "description": "Hex color"
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:f7153b2843c6b8de99e32c7199cc5873ac2824e55cc7497f15f0846f6e00dbf3",
        "scopes": [
          "linear:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "linear.save_milestone",
        "description": "마일스톤을 만들거나 고칩니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "project": {
              "type": "string",
              "description": "Project name, ID, identifier (e.g., P-ENG-123), or slug"
            },
            "id": {
              "type": "string",
              "description": "Milestone name or ID"
            },
            "name": {
              "type": "string",
              "description": "Milestone name (required when creating)"
            },
            "description": {
              "type": "string",
              "description": "Milestone description"
            },
            "targetDate": {
              "type": "string",
              "description": "Target completion date (ISO format, null to remove)"
            }
          },
          "additionalProperties": false,
          "required": [
            "project"
          ]
        },
        "schemaDigest": "sha256:54263253f92f628487cd6d7b7ae44033213c95789b72cd9f2a178fad3ef263ce",
        "scopes": [
          "linear:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "linear.save_status_update",
        "description": "프로젝트 상태 업데이트를 남기거나 고칩니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "type": {
              "type": "string",
              "description": "Type of status update",
              "enum": [
                "project",
                "initiative"
              ]
            },
            "id": {
              "type": "string",
              "description": "Update ID from get_status_updates results (statusUpdates[].id) or save_status_update's id. Omit to create"
            },
            "project": {
              "type": "string",
              "description": "Project name, ID, identifier (e.g., P-ENG-123), or slug"
            },
            "initiative": {
              "type": "string",
              "description": "Initiative name, ID, identifier (e.g., I-123), or slug"
            },
            "body": {
              "type": "string",
              "description": "Content as Markdown. Do not escape the string — use literal newlines and special characters, not escape sequences. To mention a user, use @displayName (e.g., @johndoe). Required on create; replaces the body on update. Omit on update to leave the body unchanged"
            },
            "health": {
              "type": "string",
              "description": "onTrack | atRisk | offTrack",
              "enum": [
                "onTrack",
                "atRisk",
                "offTrack"
              ]
            },
            "isDiffHidden": {
              "type": "boolean",
              "description": "Deprecated. Hide diff with previous update (create only)"
            }
          },
          "additionalProperties": false,
          "required": [
            "type"
          ]
        },
        "schemaDigest": "sha256:21021b4c98fc00760b3d6487fd5bafd526f9e73cf9f941db803243ee143242bf",
        "scopes": [
          "linear:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      }
    ]
  },
  "skill": {
    "reference": null,
    "optional": true
  },
  "momo": {
    "approvalTier": {
      "linear.get_attachment": "read_only",
      "linear.list_comments": "read_only",
      "linear.list_cycles": "read_only",
      "linear.list_custom_views": "read_only",
      "linear.get_document": "read_only",
      "linear.list_documents": "read_only",
      "linear.extract_images": "read_only",
      "linear.get_issue": "read_only",
      "linear.list_issues": "read_only",
      "linear.list_issue_statuses": "read_only",
      "linear.get_issue_status": "read_only",
      "linear.list_issue_labels": "read_only",
      "linear.list_projects": "read_only",
      "linear.get_project": "read_only",
      "linear.list_project_labels": "read_only",
      "linear.list_releases": "read_only",
      "linear.get_release": "read_only",
      "linear.list_release_notes": "read_only",
      "linear.get_release_note": "read_only",
      "linear.list_release_pipelines": "read_only",
      "linear.list_milestones": "read_only",
      "linear.get_milestone": "read_only",
      "linear.get_notifications": "read_only",
      "linear.list_teams": "read_only",
      "linear.get_team": "read_only",
      "linear.get_triage_responsibility": "read_only",
      "linear.list_templates": "read_only",
      "linear.get_template": "read_only",
      "linear.list_users": "read_only",
      "linear.get_user": "read_only",
      "linear.get_workspace": "read_only",
      "linear.search_documentation": "read_only",
      "linear.get_status_updates": "read_only",
      "linear.mark_notification": "network_write",
      "linear.save_comment": "network_write",
      "linear.save_issue": "network_write",
      "linear.save_project": "network_write",
      "linear.save_document": "network_write",
      "linear.save_milestone": "network_write",
      "linear.save_status_update": "network_write"
    },
    "risk": "medium",
    "egressDomains": [
      "mcp.linear.app"
    ],
    "recommendedFor": [
      "work-tracking",
      "product-development"
    ],
    "serverPolicy": {
      "installAllowed": true,
      "enabledByDefault": false,
      "allowedRoles": [
        "owner",
        "admin"
      ]
    }
  }
}
    $manifest$::jsonb
  )
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
  (
    'com.momo.plugins.gmail',
    '1.0.0',
    $manifest$
{
  "schemaVersion": "momo.plugin.v1",
  "plugin": {
    "id": "com.momo.plugins.gmail",
    "name": "Gmail",
    "version": "1.0.0",
    "description": "Official Google Gmail remote MCP (Developer Preview): read mail, create drafts, label. No send.",
    "publisher": {
      "id": "google",
      "name": "Google",
      "verified": true
    },
    "license": {
      "spdx": "LicenseRef-Google-Hosted-Service",
      "kind": "hosted_only"
    },
    "provenance": {
      "sourceURL": "https://developers.google.com/workspace/guides/configure-mcp-servers",
      "releaseRef": "hosted",
      "verified": true
    }
  },
  "mcp": {
    "protocolVersion": "2025-06-18",
    "transport": "streamable_http",
    "url": "https://gmailmcp.googleapis.com/mcp/v1",
    "server": {
      "name": "google/gmail-mcp",
      "version": "preview"
    },
    "tools": [
      {
        "name": "gmail.list_drafts",
        "description": "내 초안 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "pageSize": {
              "type": "integer",
              "description": "Optional. The maximum number of drafts to return. If unspecified, defaults to 20. The maximum allowed value is 50."
            },
            "pageToken": {
              "type": "string",
              "description": "Optional. A token received from a previous `list_drafts` call to retrieve the next page of results. Leave empty to fetch the first page. This is primarily used for pagination to continue fetching results from where the previous `ListDraft` call left off, especially when the number of drafts matching"
            },
            "query": {
              "type": "string",
              "description": "Examples: - `subject:OneMCP Update` - `from:gduser1@workspacesamples.dev` - `to:gduser2@workspacesamples.dev AND newer_than:7d` - `project proposal has:attachment` - `is:unread` A space or a dash (`-`) will separate a number while a dot (`.`) will be a decimal. For example, `01.2047-100` is consider"
            },
            "view": {
              "type": "string",
              "description": "Optional. Controls the fields populated for drafts in the draft list. Defaults to returning metadata only (`id`, `thread_id`, `to_recipients`, `cc_recipients`, `bcc_recipients`, `date`). Set to `DRAFT_VIEW_FULL` to include `subject` and `plaintext_body` content.",
              "enum": [
                "DRAFT_VIEW_UNSPECIFIED",
                "DRAFT_VIEW_METADATA_ONLY",
                "DRAFT_VIEW_FULL"
              ]
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:1a1b4a778594eada70f43575544a565476a26b62c7a19d9dbb8a1cd747c96b58",
        "scopes": [
          "gmail:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "gmail.get_draft",
        "description": "초안 하나를 읽습니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "draftId": {
              "type": "string",
              "description": "Required. The unique identifier of the draft to fetch."
            },
            "messageFormat": {
              "type": "string",
              "description": "Optional. Specifies the format of the draft returned. Defaults to `FULL_CONTENT`.",
              "enum": [
                "MESSAGE_FORMAT_UNSPECIFIED",
                "MINIMAL",
                "FULL_CONTENT",
                "METADATA_ONLY",
                "PLAIN_TEXT",
                "RAW"
              ]
            }
          },
          "additionalProperties": false,
          "required": [
            "draftId"
          ]
        },
        "schemaDigest": "sha256:fab5c543a22ef2288b5406b43a095a49008017db42a801aa77566942cbf98686",
        "scopes": [
          "gmail:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "gmail.get_thread",
        "description": "메일 스레드를 읽습니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "messageFormat": {
              "type": "string",
              "description": "Optional. Specifies the format of the messages returned within the thread. Defaults to `FULL_CONTENT`. We recommend using `PLAIN_TEXT` to prevent context exhaustion. Note: `MINIMAL` format returns `id`, `snippet`, `subject`, `sender`, `to_recipients`, `cc_recipients`, `bcc_recipients`, `date`, `labe",
              "enum": [
                "MESSAGE_FORMAT_UNSPECIFIED",
                "MINIMAL",
                "FULL_CONTENT",
                "METADATA_ONLY",
                "PLAIN_TEXT",
                "RAW"
              ]
            },
            "threadId": {
              "type": "string",
              "description": "Required. The unique identifier of the thread to fetch."
            }
          },
          "additionalProperties": false,
          "required": [
            "threadId"
          ]
        },
        "schemaDigest": "sha256:244e314077197af8c6e24776943bb0810a8a37c5da3c126136f17e7d134ed74a",
        "scopes": [
          "gmail:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "gmail.get_message",
        "description": "메일 한 통을 읽습니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "messageFormat": {
              "type": "string",
              "description": "Optional. Specifies the format of the message returned. Defaults to `FULL_CONTENT`. We recommend using `PLAIN_TEXT` to prevent context exhaustion.",
              "enum": [
                "MESSAGE_FORMAT_UNSPECIFIED",
                "MINIMAL",
                "FULL_CONTENT",
                "METADATA_ONLY",
                "PLAIN_TEXT",
                "RAW"
              ]
            },
            "messageId": {
              "type": "string",
              "description": "Required. The unique identifier of the message to fetch."
            }
          },
          "additionalProperties": false,
          "required": [
            "messageId"
          ]
        },
        "schemaDigest": "sha256:ec1d85234c54244b2a7c0956361af476b652771f5f6486be37f37a6d7d14c7e3",
        "scopes": [
          "gmail:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "gmail.search_threads",
        "description": "메일 스레드를 검색합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "includeTrash": {
              "type": "boolean",
              "description": "Optional. Include threads from TRASH in the results. Defaults to false."
            },
            "pageSize": {
              "type": "integer",
              "description": "Optional. The maximum number of threads to return. If unspecified, defaults to 20. The maximum allowed value is 50."
            },
            "pageToken": {
              "type": "string",
              "description": "Optional. Page token to retrieve a specific page of results in the list. Leave empty to fetch the first page. This is primarily used for pagination to continue fetching results from where the previous `SearchThreads` call left off, especially when the number of threads matching the query exceeds the"
            },
            "query": {
              "type": "string",
              "description": "Optional. A query string to filter the threads. Natural language queries must be pre-converted into Gmail syntax queries to use this tool. If omitted, all threads (excluding spam and trash by default) are listed. Supported Operators by Category: Sender & Recipient: - `from:` — Sent from a specific p"
            },
            "view": {
              "type": "string",
              "description": "Optional. Controls the fields populated for threads in the thread list. Defaults to `THREAD_VIEW_MINIMAL`. `THREAD_VIEW_MINIMAL` returns `id`, `snippet`, `subject`, `sender`, `to_recipients`, `cc_recipients`, `bcc_recipients`, `date`, `label_ids`. `THREAD_VIEW_METADATA_ONLY` returns `id`, `sender`, ",
              "enum": [
                "THREAD_VIEW_UNSPECIFIED",
                "THREAD_VIEW_METADATA_ONLY",
                "THREAD_VIEW_MINIMAL"
              ]
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:a25d49480b344911da958ba58de729be9400edf46c830e8a839a443b6c7a3050",
        "scopes": [
          "gmail:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "gmail.list_labels",
        "description": "내 라벨 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {},
          "additionalProperties": false
        },
        "schemaDigest": "sha256:83c4f4f311c68fcb05cc48b91db6bacef708c282caada779014517dbce13eae3",
        "scopes": [
          "gmail:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "gmail.create_draft",
        "description": "메일 초안을 만듭니다. 보내지는 않아요. 보내기는 Gmail에서 직접 해요.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "bcc": {
              "type": "array",
              "description": "Optional. The blind carbon copy recipients of the email draft. Each string MUST be a valid plain email address (e.g., \"user@example.com\").",
              "items": {
                "type": "string"
              }
            },
            "body": {
              "type": "string",
              "description": "Optional. The plain text body content of the email draft. Do NOT format this field with Markdown (such as headers `#`, bold `**`, bullet points `*`, or tables `|`). If formatted rich text is desired, use `html_body` instead. If `html_body` is also provided, this field is treated as the plain-text al"
            },
            "cc": {
              "type": "array",
              "description": "Optional. The carbon copy recipients of the email draft. Each string MUST be a valid plain email address (e.g., \"user@example.com\").",
              "items": {
                "type": "string"
              }
            },
            "htmlBody": {
              "type": "string",
              "description": "Optional. The HTML content of the email draft. If provided, this will be used as the rich-text version of the email. Use this field (with valid HTML tags such as ` `, ` "
            },
            "includeSignature": {
              "type": "boolean",
              "description": "Optional. Whether to append the user's configured Gmail web signature to the draft. Defaults to false."
            },
            "replyToMessageId": {
              "type": "string",
              "description": "Optional. The ID of the message to reply to. If provided, this will be used as the reply-to message ID for the email draft, and the `body` and `html_body` will be appended to the original message body."
            },
            "subject": {
              "type": "string",
              "description": "Optional. The subject line of the email. Defaults to empty if not provided."
            },
            "to": {
              "type": "array",
              "description": "Optional. The primary recipients of the email draft. Each string MUST be a valid plain email address (e.g., \"user@example.com\").",
              "items": {
                "type": "string"
              }
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:cb1cb3d52d70fc34e9bf4c4dea7e30ce826f90f66c7953b2d5eb35f27b2e2ac6",
        "scopes": [
          "gmail:draft"
        ],
        "risk": "write",
        "approvalPolicy": "require_approval"
      },
      {
        "name": "gmail.create_label",
        "description": "라벨을 새로 만듭니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "autoCreateParentLabels": {
              "type": "boolean",
              "description": "Optional. Whether to automatically create parent labels for nested labels (separated by `/`). Defaults to `true`. When set to `true`, missing parent labels in the hierarchy (e.g., `Projects` and `Projects/Alpha` for `Projects/Alpha/Sprint-1`) are created automatically. When set to `false`, parent la"
            },
            "colorPreset": {
              "type": "string",
              "description": "Optional. The color preset tile to assign to the new label. Select from predefined contrast-safe color options (e.g., LABEL_COLOR_PRESET_RED, LABEL_COLOR_PRESET_BLUE, LABEL_COLOR_PRESET_BLACK, LABEL_COLOR_PRESET_GREEN). If omitted, default label styling is applied.",
              "enum": [
                "LABEL_COLOR_PRESET_UNSPECIFIED",
                "LABEL_COLOR_PRESET_BLACK",
                "LABEL_COLOR_PRESET_DARK_GRAY",
                "LABEL_COLOR_PRESET_GRAY",
                "LABEL_COLOR_PRESET_LIGHT_GRAY",
                "LABEL_COLOR_PRESET_WHITE",
                "LABEL_COLOR_PRESET_RED",
                "LABEL_COLOR_PRESET_ORANGE",
                "LABEL_COLOR_PRESET_YELLOW",
                "LABEL_COLOR_PRESET_GREEN",
                "LABEL_COLOR_PRESET_MINT",
                "LABEL_COLOR_PRESET_TEAL",
                "LABEL_COLOR_PRESET_BLUE",
                "LABEL_COLOR_PRESET_PURPLE",
                "LABEL_COLOR_PRESET_PINK",
                "LABEL_COLOR_PRESET_DARK_RED",
                "LABEL_COLOR_PRESET_DARK_ORANGE",
                "LABEL_COLOR_PRESET_DARK_GREEN",
                "LABEL_COLOR_PRESET_DARK_BLUE",
                "LABEL_COLOR_PRESET_DARK_PURPLE",
                "LABEL_COLOR_PRESET_DARK_PINK",
                "LABEL_COLOR_PRESET_BROWN"
              ]
            },
            "displayName": {
              "type": "string",
              "description": "Required. The display name of the label to create. Supports nested label hierarchy using `/` (e.g., `Projects/Alpha/Sprint-1`)."
            },
            "labelListVisibility": {
              "type": "string",
              "description": "Optional. The visibility of the label in the label list in the Gmail web interface. Defaults to `LABEL_SHOW`.",
              "enum": [
                "LABEL_LIST_VISIBILITY_UNSPECIFIED",
                "LABEL_SHOW",
                "LABEL_SHOW_IF_UNREAD",
                "LABEL_HIDE"
              ]
            },
            "messageListVisibility": {
              "type": "string",
              "description": "Optional. The visibility of messages with this label in the message list in the Gmail web interface. Defaults to `SHOW`.",
              "enum": [
                "MESSAGE_LIST_VISIBILITY_UNSPECIFIED",
                "SHOW",
                "HIDE"
              ]
            }
          },
          "additionalProperties": false,
          "required": [
            "displayName"
          ]
        },
        "schemaDigest": "sha256:25ed2211c13f8050216f511bac515138226958aa7372fe76eb9959719b4aca2b",
        "scopes": [
          "gmail:draft"
        ],
        "risk": "write",
        "approvalPolicy": "require_approval"
      },
      {
        "name": "gmail.label_thread",
        "description": "스레드에 라벨을 붙입니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "labelIds": {
              "type": "array",
              "description": "Required. The unique identifiers of the labels to add. Can be a system label ID (e.g., `INBOX`, `STARRED`, `UNREAD`, `IMPORTANT`) or a user-defined label ID. The tool accepts `label_ids` and not label names. Use the `list_labels` tool to get the corresponding label id to a display name for user-defi",
              "items": {
                "type": "string"
              }
            },
            "threadId": {
              "type": "string",
              "description": "Required. The unique identifier of the thread to add labels to."
            }
          },
          "additionalProperties": false,
          "required": [
            "threadId",
            "labelIds"
          ]
        },
        "schemaDigest": "sha256:a74f81bdd4cdca993f3599375b4fc342078029d43ffd870f4ce805f4be0a8cef",
        "scopes": [
          "gmail:draft"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "gmail.unlabel_thread",
        "description": "스레드에서 라벨을 뗍니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "labelIds": {
              "type": "array",
              "description": "Required. The unique identifiers of the labels to remove. Can be a system label ID (e.g., `INBOX`, `TRASH`, `SPAM`, `STARRED`, `UNREAD`, `IMPORTANT`) or a user-defined label ID. The tool accepts `label_ids` and not label names. Use the `list_labels` tool to get the corresponding label id to a displa",
              "items": {
                "type": "string"
              }
            },
            "threadId": {
              "type": "string",
              "description": "Required. The unique identifier of the thread to remove labels from."
            }
          },
          "additionalProperties": false,
          "required": [
            "threadId",
            "labelIds"
          ]
        },
        "schemaDigest": "sha256:cc4fbbbddefcdf656a61c458c09109e1103444e1c58d4bcfef60a110e067c12e",
        "scopes": [
          "gmail:draft"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "gmail.label_message",
        "description": "메일 한 통에 라벨을 붙입니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "labelIds": {
              "type": "array",
              "description": "Required. The IDs of the labels to add. Can be a system label ID (e.g., `INBOX`, `STARRED`, `UNREAD`, `IMPORTANT`) or a user-defined label ID. The tool accepts `label_ids` and not label names. Use the `list_labels` tool to get the corresponding label id to a display name for user-defined labels.",
              "items": {
                "type": "string"
              }
            },
            "messageId": {
              "type": "string",
              "description": "Required. The ID of the message to add the labels to."
            }
          },
          "additionalProperties": false,
          "required": [
            "messageId",
            "labelIds"
          ]
        },
        "schemaDigest": "sha256:2b660dc100f16a62005ef0432fcce3bf18b9194cb6834fe568e1574ce74cbb5f",
        "scopes": [
          "gmail:draft"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "gmail.unlabel_message",
        "description": "메일 한 통에서 라벨을 뗍니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "labelIds": {
              "type": "array",
              "description": "Required. The IDs of the labels to remove. Can be a system label ID (e.g., `INBOX`, `TRASH`, `SPAM`, `STARRED`, `UNREAD`, `IMPORTANT`) or a user-defined label ID. The tool accepts `label_ids` and not label names. Use the `list_labels` tool to get the corresponding label id to a display name for user",
              "items": {
                "type": "string"
              }
            },
            "messageId": {
              "type": "string",
              "description": "Required. The ID of the message to remove the labels from."
            }
          },
          "additionalProperties": false,
          "required": [
            "messageId",
            "labelIds"
          ]
        },
        "schemaDigest": "sha256:5103db3e2435d9246032bb32c03beab57bc3d02d1bf0630f97be0e8d693d56c5",
        "scopes": [
          "gmail:draft"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "gmail.update_message_labels",
        "description": "메일 한 통의 라벨을 한 번에 바꿉니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "addLabelIds": {
              "type": "array",
              "description": "Optional. The IDs of the labels to add. Can be a system label ID (e.g., `INBOX`, `STARRED`, `UNREAD`, `IMPORTANT`) or a user-defined label ID.",
              "items": {
                "type": "string"
              }
            },
            "messageId": {
              "type": "string",
              "description": "Required. The ID of the message to modify labels for."
            },
            "removeLabelIds": {
              "type": "array",
              "description": "Optional. The IDs of the labels to remove. Can be a system label ID or a user-defined label ID.",
              "items": {
                "type": "string"
              }
            }
          },
          "additionalProperties": false,
          "required": [
            "messageId"
          ]
        },
        "schemaDigest": "sha256:afddc76e38afe1c3390156c6efd12c10429926de03bc93c79d83a69575f3a1c4",
        "scopes": [
          "gmail:draft"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      }
    ]
  },
  "skill": {
    "reference": null,
    "optional": true
  },
  "momo": {
    "approvalTier": {
      "gmail.list_drafts": "read_only",
      "gmail.get_draft": "read_only",
      "gmail.get_thread": "read_only",
      "gmail.get_message": "read_only",
      "gmail.search_threads": "read_only",
      "gmail.list_labels": "read_only",
      "gmail.create_draft": "network_write",
      "gmail.create_label": "network_write",
      "gmail.label_thread": "network_write",
      "gmail.unlabel_thread": "network_write",
      "gmail.label_message": "network_write",
      "gmail.unlabel_message": "network_write",
      "gmail.update_message_labels": "network_write"
    },
    "risk": "medium",
    "egressDomains": [
      "gmailmcp.googleapis.com"
    ],
    "recommendedFor": [
      "communication",
      "productivity"
    ],
    "serverPolicy": {
      "installAllowed": true,
      "enabledByDefault": false,
      "allowedRoles": [
        "owner",
        "admin"
      ]
    },
    "preview": true
  }
}
    $manifest$::jsonb
  ),
  (
    'com.momo.plugins.google-calendar',
    '1.0.0',
    $manifest$
{
  "schemaVersion": "momo.plugin.v1",
  "plugin": {
    "id": "com.momo.plugins.google-calendar",
    "name": "Google Calendar",
    "version": "1.0.0",
    "description": "Official Google Calendar remote MCP (Developer Preview)",
    "publisher": {
      "id": "google",
      "name": "Google",
      "verified": true
    },
    "license": {
      "spdx": "LicenseRef-Google-Hosted-Service",
      "kind": "hosted_only"
    },
    "provenance": {
      "sourceURL": "https://developers.google.com/workspace/guides/configure-mcp-servers",
      "releaseRef": "hosted",
      "verified": true
    }
  },
  "mcp": {
    "protocolVersion": "2025-06-18",
    "transport": "streamable_http",
    "url": "https://calendarmcp.googleapis.com/mcp/v1",
    "server": {
      "name": "google/calendar-mcp",
      "version": "preview"
    },
    "tools": [
      {
        "name": "google-calendar.list_events",
        "description": "캘린더의 일정 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "calendarId": {
              "type": "string",
              "description": "Optional. ID of the calendar containing the events. Email address - can be resolved using `list_calendars`. Default: primary calendar."
            },
            "endTime": {
              "type": "string",
              "description": "Optional. The upper bound of a time range. Must only be set when a specific timeframe or a time in the past is requested by the user. Must be an ISO 8601 timestamp greater than `start_time`. Default: `start_time` + 7 days. Follows the same rules as `start_time`, including when passing `start_time` +"
            },
            "eventType": {
              "type": "array",
              "description": "Optional. The event types to return. If empty, only the following event types are returned: `DEFAULT`, `OUT_OF_OFFICE`, `FOCUS_TIME`, `FROM_GMAIL`",
              "items": {
                "type": "string",
                "enum": [
                  "EVENT_TYPE_UNSPECIFIED",
                  "DEFAULT",
                  "OUT_OF_OFFICE",
                  "FOCUS_TIME",
                  "WORKING_LOCATION",
                  "BIRTHDAY",
                  "FROM_GMAIL"
                ]
              }
            },
            "eventTypeFilter": {
              "type": "array",
              "description": "Optional. Deprecated: use `event_type` instead.",
              "items": {
                "type": "string"
              }
            },
            "fullText": {
              "type": "string",
              "description": "Optional. Free-form case-insensitive search matching title, description, location, or attendees. Matches events containing all query terms verbatim (AND search)."
            },
            "orderBy": {
              "type": "string",
              "description": "Optional. The order in which events should be returned. Possible values are: - `default` - Unspecified, but deterministic ordering (default). - `startTime` - Order by start time ascending. - `startTimeDesc` - Order by start time descending. - `lastModified` - Order by last modification time ascendin"
            },
            "pageSize": {
              "type": "integer",
              "description": "Optional. Max events per page (default `100`, max `250`). Recommended: `10`."
            },
            "pageToken": {
              "type": "string",
              "description": "Optional. Next page token. Use the value from the previous page's `nextPageToken`."
            },
            "startTime": {
              "type": "string",
              "description": "Optional. The lower bound of a time range. Must only be set when a specific timeframe is requested by the user. Must be an ISO 8601 timestamp less than `end_time`. Default: now. Pass the local time with no UTC offset and no trailing `Z` (for example `2026-04-30T10:00:00`), including when passing now"
            },
            "timeZone": {
              "type": "string",
              "description": "Optional. The time zone (IANA ID, for example `Europe/Zurich`) used to resolve timezone-less dates. Only use this parameter if the user explicitly states a time zone, but always set it when they do, even if that time zone looks like the user's own. Otherwise leave it unset: the server resolves the u"
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:b276ca3f483c9d8ab41a831461b64dad1d6336b50cc51c27663f76ca830b8929",
        "scopes": [
          "google-calendar:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "google-calendar.get_event",
        "description": "일정 하나를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "calendarId": {
              "type": "string",
              "description": "Optional. ID of the calendar containing the event. Email address - can be resolved using `list_calendars`. Default: primary calendar."
            },
            "eventId": {
              "type": "string",
              "description": "Required. Event ID. Can be resolved using `list_events` or `search_events`."
            }
          },
          "additionalProperties": false,
          "required": [
            "eventId"
          ]
        },
        "schemaDigest": "sha256:86881e99fc987c3e8b3884d0216c30795d17ae7e7892599e0dfe1f3345794e4e",
        "scopes": [
          "google-calendar:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "google-calendar.list_calendars",
        "description": "내 캘린더 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "pageSize": {
              "type": "integer",
              "description": "Optional. Max results per page. Default `100`, max `250`."
            },
            "pageToken": {
              "type": "string",
              "description": "Optional. Token specifying which result page to return."
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:4b7adc0c2f5a23de8a591ad584f3a669db0f5de7e4d315cee4447a6ebf925ba2",
        "scopes": [
          "google-calendar:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "google-calendar.suggest_time",
        "description": "참석자들이 모두 비는 시간을 제안합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "attendeeEmails": {
              "type": "array",
              "description": "Required. Attendee emails to find free time for.",
              "items": {
                "type": "string"
              }
            },
            "durationMinutes": {
              "type": "integer",
              "description": "Optional. Min duration of free slot in minutes. Default: `30`."
            },
            "endTime": {
              "type": "string",
              "description": "Required. Query interval end (ISO 8601). Follows the same rules as `start_time`."
            },
            "startTime": {
              "type": "string",
              "description": "Required. Query interval start (ISO 8601). Pass the local time with no UTC offset and no trailing `Z` (for example `2026-04-30T10:00:00`); only include an offset if the user themselves stated one. If the user named a time zone, leave this without offset and put its IANA name in this request's top-le"
            },
            "timeZone": {
              "type": "string",
              "description": "Optional. The time zone the search times should be interpreted in (IANA ID, for example `Europe/Zurich`). Only use this parameter if the user explicitly states a time zone, but always set it when they do, even if that time zone looks like the user's own. Otherwise leave it unset: the server resolves"
            }
          },
          "additionalProperties": false,
          "required": [
            "attendeeEmails",
            "startTime",
            "endTime"
          ]
        },
        "schemaDigest": "sha256:0f4fa93debceb3b545d342a4adcece15c0504dd75f62e887ab3af8b3d5b684e1",
        "scopes": [
          "google-calendar:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "google-calendar.search_events",
        "description": "일정을 검색합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "pageSize": {
              "type": "integer",
              "description": "Optional. Maximum number of entries returned on one result page."
            },
            "pageToken": {
              "type": "string",
              "description": "Optional. Token specifying which result page to return."
            },
            "query": {
              "type": "string",
              "description": "Required. Query string to search for events (case-insensitive)."
            }
          },
          "additionalProperties": false,
          "required": [
            "query"
          ]
        },
        "schemaDigest": "sha256:2e7594f0963d00764fd9244878b36f1fcc73d6c18e866f34133aaa526334f025",
        "scopes": [
          "google-calendar:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "google-calendar.create_event",
        "description": "일정을 만듭니다. 참석자가 있으면 초대가 나가요.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "addGoogleMeetUrl": {
              "type": "boolean",
              "description": "Optional. Create and add a Google Meet URL. Default: `false`."
            },
            "allDay": {
              "type": "boolean",
              "description": "Optional. Whether the event spans the entire day. If true, start/end times are treated as midnight."
            },
            "attendeeEmails": {
              "type": "array",
              "description": "Optional. Deprecated: use `attendees` instead.",
              "items": {
                "type": "string"
              }
            },
            "availability": {
              "type": "string",
              "description": "Optional. Availability setting.",
              "enum": [
                "AVAILABILITY_UNSPECIFIED",
                "AVAILABILITY_BUSY",
                "AVAILABILITY_FREE"
              ]
            },
            "calendarId": {
              "type": "string",
              "description": "Optional. ID of the calendar to create the event on. Email address - can be resolved using `list_calendars`. Default: primary calendar."
            },
            "colorId": {
              "type": "string",
              "description": "Optional. The color of the event. For a list of color IDs, refer to the documentation of the Event resource."
            },
            "description": {
              "type": "string",
              "description": "Optional. Description. Can contain HTML."
            },
            "endTime": {
              "type": "string",
              "description": "Required. End time (ISO 8601, for example `2026-04-30T11:00:00`). Follows the same rules as `start_time`."
            },
            "eventType": {
              "type": "string",
              "description": "Optional. Type of the event.",
              "enum": [
                "EVENT_TYPE_UNSPECIFIED",
                "DEFAULT",
                "OUT_OF_OFFICE",
                "FOCUS_TIME",
                "WORKING_LOCATION",
                "BIRTHDAY",
                "FROM_GMAIL"
              ]
            },
            "googleMeetUrl": {
              "type": "string",
              "description": "Optional. Specific Google Meet URL or meeting ID. Overrides `add_google_meet_url`."
            },
            "location": {
              "type": "string",
              "description": "Optional. Location."
            },
            "notificationLevel": {
              "type": "string",
              "description": "Optional. Which email notification should be sent for this event update.",
              "enum": [
                "NOTIFICATION_LEVEL_UNSPECIFIED",
                "NONE",
                "EXTERNAL_ONLY",
                "ALL"
              ]
            },
            "recurrenceData": {
              "type": "array",
              "description": "Optional. Recurrence rules as `RRULE`, `RDATE`, or `EXDATE` strings (per RFC 5545).",
              "items": {
                "type": "string"
              }
            },
            "startTime": {
              "type": "string",
              "description": "Required. Start time (ISO 8601, for example `2026-04-30T10:00:00`). Pass the local time with no UTC offset and no trailing `Z`; only include an offset if the user themselves stated one. If the user named a time zone, leave this without offset and put its IANA name in this request's top-level `timeZo"
            },
            "summary": {
              "type": "string",
              "description": "Required. Title."
            },
            "timeZone": {
              "type": "string",
              "description": "Optional. The time zone the event should be created in, as an IANA Time Zone Database name (for example, `America/Los_Angeles`). Only use this parameter if the user explicitly states a time zone, but always set it when they do, even if that time zone looks like the user's own. Otherwise leave it uns"
            },
            "useDefaultReminders": {
              "type": "boolean",
              "description": "Optional. Whether to use the default reminders for the event. If true, the event will use default reminders. Cannot be set to true if `override_reminders` are specified. If set to false and `override_reminders` is empty or unset, the event will have no reminders. Defaults to false if override_remind"
            },
            "visibility": {
              "type": "string",
              "description": "Optional. Visibility of the event. Possible values are: - `default` - Uses the default visibility for events on the calendar. Default value. - `public` - The event is public and event details are visible to all readers of the calendar. - `private` - Only event attendees may view event details. "
            }
          },
          "additionalProperties": false,
          "required": [
            "summary",
            "startTime",
            "endTime"
          ]
        },
        "schemaDigest": "sha256:d0d919ee9e2297cf06ebb6727c1b02e54b4c20fbd09822b0dab93c940e6b9ef1",
        "scopes": [
          "google-calendar:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "google-calendar.update_event",
        "description": "일정을 고칩니다. 참석자에게 알림이 갈 수 있어요.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "addGoogleMeetUrl": {
              "type": "boolean",
              "description": "Optional. If true, creates or updates a Google Meet URL for the event. Ignored if Meet is disabled."
            },
            "addedAttendeeEmails": {
              "type": "array",
              "description": "Optional. Deprecated: use `added_attendees` instead.",
              "items": {
                "type": "string"
              }
            },
            "allDay": {
              "type": "boolean",
              "description": "Optional. Changes the event to all-day. If set, `start_time`/`end_time` must also be provided."
            },
            "availability": {
              "type": "string",
              "description": "Optional. Whether the event blocks time on the calendar.",
              "enum": [
                "AVAILABILITY_UNSPECIFIED",
                "AVAILABILITY_BUSY",
                "AVAILABILITY_FREE"
              ]
            },
            "calendarId": {
              "type": "string",
              "description": "Optional. ID of the calendar containing the event. Email address - can be resolved using `list_calendars`. Default: primary calendar."
            },
            "colorId": {
              "type": "string",
              "description": "Optional. New color of the event. For a list of color IDs, refer to the documentation of the Event resource."
            },
            "description": {
              "type": "string",
              "description": "Optional. New description. Can contain HTML."
            },
            "endTime": {
              "type": "string",
              "description": "Optional. New end time (ISO 8601). Follows the same rules as `start_time`."
            },
            "eventId": {
              "type": "string",
              "description": "Required. Event ID. Can be resolved using `list_events` or `search_events`."
            },
            "googleMeetUrl": {
              "type": "string",
              "description": "Optional. Allows attaching an existing Google Meet URL or meeting ID to the event. Overrides the value of `addGoogleMeetUrl`."
            },
            "location": {
              "type": "string",
              "description": "Optional. New location."
            },
            "notificationLevel": {
              "type": "string",
              "description": "Optional. Email notification to send for this event update. Default: `ALL`.",
              "enum": [
                "NOTIFICATION_LEVEL_UNSPECIFIED",
                "NONE",
                "EXTERNAL_ONLY",
                "ALL"
              ]
            },
            "removedAttachmentFileUrls": {
              "type": "array",
              "description": "Optional. File attachments to remove from the event.",
              "items": {
                "type": "string"
              }
            },
            "removedAttendeeEmails": {
              "type": "array",
              "description": "Optional. The attendees of the event to remove, as email addresses.",
              "items": {
                "type": "string"
              }
            },
            "startTime": {
              "type": "string",
              "description": "Optional. New start time (ISO 8601). Preserves duration if updating only start. Pass the local time with no UTC offset and no trailing `Z` (for example `2026-04-30T10:00:00`); only include an offset if the user themselves stated one. If the user named a time zone, leave this without offset and put i"
            },
            "summary": {
              "type": "string",
              "description": "Optional. New title."
            },
            "timeZone": {
              "type": "string",
              "description": "Optional. The time zone the event should be updated to, as an IANA Time Zone Database name (for example, `America/Los_Angeles`). Only use this parameter if the user explicitly states a time zone, but always set it when they do, even if that time zone looks like the user's own. Otherwise leave it uns"
            },
            "useDefaultReminders": {
              "type": "boolean",
              "description": "Optional. Whether to use the default reminders for the event. If true, the event will use default reminders (and clear override reminders). Cannot be set to true if `override_reminders` are specified. If set to false and `override_reminders` is empty or unset, all reminders are removed."
            },
            "visibility": {
              "type": "string",
              "description": "Optional. New visibility of the event. Possible values are: - `default` - Uses the default visibility for events on the calendar. Default value. - `public` - Event details are visible to all readers of the calendar. - `private` - The event is private and only event attendees may view event details. "
            }
          },
          "additionalProperties": false,
          "required": [
            "eventId"
          ]
        },
        "schemaDigest": "sha256:27a0e31418b2d72296b1b1424af08dca79a68b5911da4d92665fefd5f7098187",
        "scopes": [
          "google-calendar:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      },
      {
        "name": "google-calendar.respond_to_event",
        "description": "초대받은 일정에 참석 여부를 답합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "calendarId": {
              "type": "string",
              "description": "Optional. ID of the calendar containing the event. Email address - can be resolved using `list_calendars`. Default: primary calendar."
            },
            "eventId": {
              "type": "string",
              "description": "Required. The ID of the event to respond to."
            },
            "notificationLevel": {
              "type": "string",
              "description": "Optional. Which email notification should be sent for this event update.",
              "enum": [
                "NOTIFICATION_LEVEL_UNSPECIFIED",
                "NONE",
                "EXTERNAL_ONLY",
                "ALL"
              ]
            },
            "responseComment": {
              "type": "string",
              "description": "Optional. The user's comment attached to the response."
            },
            "responseStatus": {
              "type": "string",
              "description": "Required. The new user's response status of the event. Possible values are: - `declined` - The attendee has declined the invitation. - `tentative` - The attendee has tentatively accepted the invitation. - `accepted` - The attendee has accepted the invitation. "
            }
          },
          "additionalProperties": false,
          "required": [
            "eventId",
            "responseStatus"
          ]
        },
        "schemaDigest": "sha256:56537beb3ddc83de18e717b14388809938dd07492da17e3a9042bbd453c363e1",
        "scopes": [
          "google-calendar:write"
        ],
        "risk": "write",
        "approvalPolicy": "always"
      }
    ]
  },
  "skill": {
    "reference": null,
    "optional": true
  },
  "momo": {
    "approvalTier": {
      "google-calendar.list_events": "read_only",
      "google-calendar.get_event": "read_only",
      "google-calendar.list_calendars": "read_only",
      "google-calendar.suggest_time": "read_only",
      "google-calendar.search_events": "read_only",
      "google-calendar.create_event": "network_write",
      "google-calendar.update_event": "network_write",
      "google-calendar.respond_to_event": "network_write"
    },
    "risk": "medium",
    "egressDomains": [
      "calendarmcp.googleapis.com"
    ],
    "recommendedFor": [
      "scheduling",
      "productivity"
    ],
    "serverPolicy": {
      "installAllowed": true,
      "enabledByDefault": false,
      "allowedRoles": [
        "owner",
        "admin"
      ]
    },
    "preview": true
  }
}
    $manifest$::jsonb
  ),
  (
    'com.momo.plugins.google-drive',
    '1.0.0',
    $manifest$
{
  "schemaVersion": "momo.plugin.v1",
  "plugin": {
    "id": "com.momo.plugins.google-drive",
    "name": "Google 내 드라이브",
    "version": "1.0.0",
    "description": "Official Google Drive remote MCP (Developer Preview), the signed-in person's own Drive",
    "publisher": {
      "id": "google",
      "name": "Google",
      "verified": true
    },
    "license": {
      "spdx": "LicenseRef-Google-Hosted-Service",
      "kind": "hosted_only"
    },
    "provenance": {
      "sourceURL": "https://developers.google.com/workspace/guides/configure-mcp-servers",
      "releaseRef": "hosted",
      "verified": true
    }
  },
  "mcp": {
    "protocolVersion": "2025-06-18",
    "transport": "streamable_http",
    "url": "https://drivemcp.googleapis.com/mcp/v1",
    "server": {
      "name": "google/drive-mcp",
      "version": "preview"
    },
    "tools": [
      {
        "name": "google-drive.search_files",
        "description": "내 드라이브에서 파일을 검색합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "excludeContentSnippets": {
              "type": "boolean",
              "description": "If true, the content snippet will be excluded from the response."
            },
            "pageSize": {
              "type": "integer",
              "description": "The maximum number of files to return in each page."
            },
            "pageToken": {
              "type": "string",
              "description": "The page token to use for pagination."
            },
            "query": {
              "type": "string",
              "description": "The search query."
            },
            "snippetVerbosity": {
              "type": "string",
              "description": "Optional. Set to specify how verbose the snippets should be. Defaults to DETAILED if not set.",
              "enum": [
                "UNSPECIFIED",
                "BRIEF",
                "MEDIUM",
                "DETAILED",
                "MAX_ALLOWED"
              ]
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:601474b26b4a5708f0e85b5360db67c99297a4cc9ae27368bd7caa44c5f19f66",
        "scopes": [
          "google-drive:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "google-drive.list_recent_files",
        "description": "최근 파일 목록을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "excludeContentSnippets": {
              "type": "boolean",
              "description": "If true, the content snippet will be excluded from the response."
            },
            "orderBy": {
              "type": "string",
              "description": "The sort order for the files."
            },
            "pageSize": {
              "type": "integer",
              "description": "The maximum number of files to return."
            },
            "pageToken": {
              "type": "string",
              "description": "The page token to use for pagination."
            },
            "snippetVerbosity": {
              "type": "string",
              "description": "Optional. Set to specify how verbose the snippets should be. Defaults to DETAILED if not set.",
              "enum": [
                "UNSPECIFIED",
                "BRIEF",
                "MEDIUM",
                "DETAILED",
                "MAX_ALLOWED"
              ]
            }
          },
          "additionalProperties": false
        },
        "schemaDigest": "sha256:94b9a1d889646ff89f35479713b9c1f8bf2377df9f5501d5a630ecfc8e47f40b",
        "scopes": [
          "google-drive:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "google-drive.get_file_metadata",
        "description": "파일의 메타데이터를 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "excludeContentSnippets": {
              "type": "boolean",
              "description": "If true, the content snippet will be excluded from the response."
            },
            "fileId": {
              "type": "string",
              "description": "Required. The ID of the file to retrieve."
            },
            "snippetVerbosity": {
              "type": "string",
              "description": "Optional. Set to specify how verbose the snippets should be. Defaults to DETAILED if not set.",
              "enum": [
                "UNSPECIFIED",
                "BRIEF",
                "MEDIUM",
                "DETAILED",
                "MAX_ALLOWED"
              ]
            }
          },
          "additionalProperties": false,
          "required": [
            "fileId"
          ]
        },
        "schemaDigest": "sha256:287fa1f9e033d3f0957c99794de934c761a9f6345a5aef282725c9234e44f5f2",
        "scopes": [
          "google-drive:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "google-drive.get_file_permissions",
        "description": "파일의 공유 설정을 조회합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "fileId": {
              "type": "string",
              "description": "Required. The ID of the file to get permissions for."
            }
          },
          "additionalProperties": false,
          "required": [
            "fileId"
          ]
        },
        "schemaDigest": "sha256:4f25d15703d00177736d7f5c784244c93644fd7c6048fd3f38d484cca13f745e",
        "scopes": [
          "google-drive:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "google-drive.read_file_content",
        "description": "파일 내용을 텍스트로 읽습니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "fileId": {
              "type": "string",
              "description": "Required. The ID of the file to retrieve."
            },
            "includeComments": {
              "type": "boolean",
              "description": "Whether to include comments in the response. Comments will be inlined in the text content of the file with a mapping to the comment threads. Note: Comments are only supported for Google Docs, Slides, and Sheets."
            }
          },
          "additionalProperties": false,
          "required": [
            "fileId"
          ]
        },
        "schemaDigest": "sha256:eb629283350964d6f316a37eec0812f39ef25fbdcd5cc52360306fb20fb17469",
        "scopes": [
          "google-drive:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "google-drive.download_file_content",
        "description": "파일 내용을 내려받습니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "exportMimeType": {
              "type": "string",
              "description": "Optional. For Google native files, the MIME type to export the file to, ignored otherwise. Defaults to text if not specified."
            },
            "fileId": {
              "type": "string",
              "description": "Required. The ID of the file to retrieve."
            },
            "revisionId": {
              "type": "string",
              "description": "Optional. The revision id for the version of the file to download. If not specified, the latest revision will be downloaded."
            }
          },
          "additionalProperties": false,
          "required": [
            "fileId"
          ]
        },
        "schemaDigest": "sha256:9b0193f2f2c53d7df33358fc507277a9cdec1f3a40873c61d5ba11167acc7696",
        "scopes": [
          "google-drive:read"
        ],
        "risk": "read",
        "approvalPolicy": "none"
      },
      {
        "name": "google-drive.create_file",
        "description": "내 드라이브에 파일을 만듭니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "base64Content": {
              "type": "string",
              "description": "Optional. The base64 encoded content to upload. It's an error to set this and `textContent`."
            },
            "content": {
              "type": "string",
              "description": "Deprecated: Use `base64Content` or `textContent` instead. The content of the file encoded as base64. The content field should always be base64 encoded regardless of the mime type of the file."
            },
            "contentMimeType": {
              "type": "string",
              "description": "The mime type of the content being uploaded. Required when any type of content is provided."
            },
            "disableConversionToGoogleType": {
              "type": "boolean",
              "description": "Set to true to retain the passed in content mime type and not convert to a Google type. For example, without this a `text/plain` content mime type will be converted to to `application/vnd.google-apps.document`. Has no effect for types that do not have a Google equivalent."
            },
            "mimeType": {
              "type": "string",
              "description": "Deprecated: DO NOT USE!! Set `contentMimeType` instead."
            },
            "parentId": {
              "type": "string",
              "description": "The parent id of the file."
            },
            "textContent": {
              "type": "string",
              "description": "Optional. The (UTF-8) text content to upload. It's an error to set this and `base64Content`."
            },
            "title": {
              "type": "string",
              "description": "Required. The title of the file."
            }
          },
          "additionalProperties": false,
          "required": [
            "title"
          ]
        },
        "schemaDigest": "sha256:4ad2af5128283de1d80851010cc82c358501cdb2f72359c44beef6051f826701",
        "scopes": [
          "google-drive:write"
        ],
        "risk": "write",
        "approvalPolicy": "require_approval"
      },
      {
        "name": "google-drive.copy_file",
        "description": "파일을 복사합니다.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "fileId": {
              "type": "string",
              "description": "Required. The ID of the file to copy."
            },
            "parentId": {
              "type": "string",
              "description": "The parent id of the newly created file. If empty, the file will be created with the same parent as the original file."
            },
            "title": {
              "type": "string",
              "description": "The title of the newly created file. If empty, the title will be 'Copy of {original file title}'."
            }
          },
          "additionalProperties": false,
          "required": [
            "fileId"
          ]
        },
        "schemaDigest": "sha256:1d13a3b45eddb6d150eb2dd6c05c72b4e033e82e5020f79fecc0b97a5786741c",
        "scopes": [
          "google-drive:write"
        ],
        "risk": "write",
        "approvalPolicy": "require_approval"
      }
    ]
  },
  "skill": {
    "reference": null,
    "optional": true
  },
  "momo": {
    "approvalTier": {
      "google-drive.search_files": "read_only",
      "google-drive.list_recent_files": "read_only",
      "google-drive.get_file_metadata": "read_only",
      "google-drive.get_file_permissions": "read_only",
      "google-drive.read_file_content": "read_only",
      "google-drive.download_file_content": "read_only",
      "google-drive.create_file": "network_write",
      "google-drive.copy_file": "network_write"
    },
    "risk": "medium",
    "egressDomains": [
      "drivemcp.googleapis.com"
    ],
    "recommendedFor": [
      "knowledge-management",
      "productivity"
    ],
    "serverPolicy": {
      "installAllowed": true,
      "enabledByDefault": false,
      "allowedRoles": [
        "owner",
        "admin"
      ]
    },
    "preview": true
  }
}
    $manifest$::jsonb
  )
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
    RAISE NOTICE '142: role cannot bypass RLS; capability projections of existing grants keep their old rows until re-granted';
  END IF;
END $$;
