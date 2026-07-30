@preconcurrency import Crypto
import XCTest
import Hummingbird
@testable import MomoServer

final class MomoServerTests: XCTestCase {
    func testSmoke() {
        XCTAssertEqual("MomoServer", "MomoServer")
    }

    func testDatabaseSecurityPostureBootGuardScopeAndValidation() throws {
        for environment in ["staging", "prod", "production", "internal-host", "internal-smoke"] {
            XCTAssertTrue(DatabaseSecurityPosture.requiresBootGuard(environmentName: environment))
        }
        for environment in ["local", "dev", "test", ""] {
            XCTAssertFalse(DatabaseSecurityPosture.requiresBootGuard(environmentName: environment))
        }

        XCTAssertNoThrow(try DatabaseSecurityPosture(
            currentUser: "momo_app", isSuperuser: false, bypassesRLS: false
        ).validateForAPIBoot())
        XCTAssertThrowsError(try DatabaseSecurityPosture(
            currentUser: "momo", isSuperuser: true, bypassesRLS: true
        ).validateForAPIBoot()) { error in
            XCTAssertEqual(error as? DatabaseSecurityPostureError, .unexpectedRole("momo"))
        }
        XCTAssertThrowsError(try DatabaseSecurityPosture(
            currentUser: "momo_app", isSuperuser: true, bypassesRLS: false
        ).validateForAPIBoot()) { error in
            XCTAssertEqual(error as? DatabaseSecurityPostureError, .superuser("momo_app"))
        }
        XCTAssertThrowsError(try DatabaseSecurityPosture(
            currentUser: "momo_app", isSuperuser: false, bypassesRLS: true
        ).validateForAPIBoot()) { error in
            XCTAssertEqual(error as? DatabaseSecurityPostureError, .bypassesRLS("momo_app"))
        }
    }

    func testOfficialPluginManifestsValidateAndMatchVerifiedEndpoints() throws {
        let fixtures = try pluginFixtureDirectory()
        let expected: [(String, String, String?, [String], Bool)] = [
            ("github", "com.momo.plugins.github", "api.githubcopilot.com", ["api.githubcopilot.com"], false),
            ("notion", "com.momo.plugins.notion", "mcp.notion.com", ["mcp.notion.com"], false),
            ("linear", "com.momo.plugins.linear", "mcp.linear.app", ["mcp.linear.app"], false),
            ("drive", "com.momo.plugins.drive", nil, ["www.googleapis.com", "oauth2.googleapis.com"], true),
        ]
        let digest = "sha256:" + String(repeating: "a", count: 64)
        for (fixture, pluginID, domain, egressDomains, hosted) in expected {
            let json = try String(
                contentsOf: fixtures.appendingPathComponent("\(fixture).json"),
                encoding: .utf8
            )
            let manifest = try PluginManifestValidator.validate(
                manifestJSON: json,
                expectedDigest: digest,
                computedDigest: digest,
                revoked: false
            )
            XCTAssertEqual(manifest.pluginID, pluginID)
            XCTAssertEqual(manifest.mcpTransport, "streamable_http")
            XCTAssertEqual(URL(string: manifest.mcpURL)?.host, domain)
            XCTAssertEqual(manifest.egressDomains, egressDomains)
            XCTAssertEqual(manifest.hosted, hosted)
            XCTAssertNil(manifest.termsURL)
            XCTAssertNil(manifest.privacyPolicyURL)
            XCTAssertNil(manifest.iconText)
            XCTAssertFalse(manifest.enabledByDefault)
            XCTAssertEqual(manifest.allowedRoles, ["owner", "admin"])
        }
    }

    /// 자사 카탈로그의 tools[].description 은 두 곳에 산다: 정본인 픽스처와,
    /// 그것을 plugin_registry 에 심는 재시드 마이그레이션(013/015/031 → 059).
    /// 둘이 갈라지면 배포된 DB가 앱 상세("도구와 권한")에서 픽스처와 다른 문장을
    /// 보여주는데, 어느 화면도 그 사실을 알려주지 않는다. 문자열 동일성을 여기서
    /// 잠근다. 이 단정은 자사 4종만 다룬다 — 제3자 매니페스트는 어떤 언어로도
    /// 들어올 수 있어 데이터 번역으로 닫히지 않고, 그래서 결정 표면(동의
    /// 다이얼로그)은 배포자 산문 대신 도구 이름으로 도구를 식별한다(#914/#917).
    func testOfficialPluginManifestToolDescriptionsAreKoreanAndMatchReseedMigration() throws {
        let expected: [(fixture: String, tool: String, korean: String, legacy: String)] = [
            ("github", "github.list_repositories",
             "권한을 위임한 사용자가 접근할 수 있는 저장소 목록을 조회합니다.",
             "List repositories available to the delegated user"),
            ("github", "github.search_issues",
             "권한을 위임한 사용자가 접근할 수 있는 저장소에서 이슈를 검색합니다.",
             "Search issues in repositories available to the delegated user"),
            ("notion", "notion.search",
             "권한을 위임한 사용자가 접근할 수 있는 페이지를 검색합니다.",
             "Search pages available to the delegated user"),
            ("linear", "linear.list_issues",
             "권한을 위임한 사용자가 접근할 수 있는 이슈 목록을 조회합니다.",
             "List issues available to the delegated user"),
            ("drive", "drive.search_files",
             "설정된 공유 드라이브 안에서 파일을 검색합니다.",
             "Search files within the configured shared drive"),
            ("drive", "drive.get_file_metadata",
             "설정된 공유 드라이브에 있는 파일의 메타데이터를 조회합니다.",
             "Get metadata for a file in the configured shared drive"),
            ("drive", "drive.export_text",
             "Google Workspace 문서를 텍스트로 내보내거나 크기 한도 안의 텍스트 파일을 내려받습니다.",
             "Export a Google Workspace document or download a bounded text file"),
        ]
        let fixtures = try pluginFixtureDirectory()
        let fixtureNames = ["github", "notion", "linear", "drive"]

        var declared: [String: String] = [:]
        for fixtureName in fixtureNames {
            let data = try Data(contentsOf: fixtures.appendingPathComponent("\(fixtureName).json"))
            let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let mcp = try XCTUnwrap(root["mcp"] as? [String: Any])
            let tools = try XCTUnwrap(mcp["tools"] as? [[String: Any]])
            for tool in tools {
                let name = try XCTUnwrap(tool["name"] as? String)
                let description = try XCTUnwrap(tool["description"] as? String)
                // 새 도구가 영문으로 들어오면 이 표를 갱신하지 않고는 통과하지 못한다.
                XCTAssertTrue(
                    description.unicodeScalars.contains { (0xAC00...0xD7A3).contains($0.value) },
                    "\(name) description must be Korean"
                )
                declared[name] = description
            }
        }
        XCTAssertEqual(declared.count, expected.count)

        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let reseed = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Migrations/059_official_manifest_tool_description_ko.sql"
            ),
            encoding: .utf8
        )
        for entry in expected {
            XCTAssertEqual(declared[entry.tool], entry.korean, "\(entry.tool) fixture description")
            XCTAssertTrue(reseed.contains("'\(entry.tool)'"), "\(entry.tool) missing from reseed")
            XCTAssertTrue(reseed.contains("'\(entry.korean)'"), "\(entry.tool) korean text missing from reseed")
            // 재시드는 "아직 013/015/031 원문 그대로인 행"만 건드린다 — 배포자가 고친
            // 매니페스트를 덮어쓰지 않고, 재실행에서도 0행이라 멱등이다.
            XCTAssertTrue(reseed.contains("'\(entry.legacy)'"), "\(entry.tool) legacy guard missing from reseed")
        }
        XCTAssertTrue(reseed.contains("pr.plugin_id IN (SELECT DISTINCT plugin_id FROM ko)"))
        XCTAssertTrue(reseed.contains("pr.manifest IS DISTINCT FROM rw.manifest"))

        // manifest 만 바꾸고 digest 를 두면 런타임 admission 이 카탈로그 전체를
        // fail-closed 로 닫는다. 재시드가 회전시키는 식이 런타임이 계산하는 식과
        // 같은 문자열이어야 한다.
        XCTAssertTrue(reseed.contains("'sha256:' || encode(sha256(convert_to(rw.manifest::text, 'UTF8')), 'hex')"))
        let pluginRoutes = try String(
            contentsOf: serverRoot.appendingPathComponent("Sources/MomoServer/Routes/PluginRoutes.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(pluginRoutes.contains("'sha256:' || encode(sha256(convert_to(pr.manifest::text, 'UTF8')), 'hex')"))
    }

    func testPluginManifestOptionalDisplayMetadataIsValidated() throws {
        let fixture = try String(
            contentsOf: try pluginFixtureDirectory().appendingPathComponent("github.json"),
            encoding: .utf8
        )
        let displayManifest = fixture.replacingOccurrences(
            of: "\"description\": \"Official GitHub hosted MCP integration\",",
            with: """
            \"description\": \"Official GitHub hosted MCP integration\",
            \"termsURL\": \"https://publisher.example/terms\",
            \"privacyPolicyURL\": \"https://publisher.example/privacy\",
            \"iconText\": \"GH\",
            """
        )
        let digest = "sha256:" + String(repeating: "a", count: 64)
        let manifest = try PluginManifestValidator.validate(
            manifestJSON: displayManifest,
            expectedDigest: digest,
            computedDigest: digest,
            revoked: false
        )
        XCTAssertEqual(manifest.termsURL, "https://publisher.example/terms")
        XCTAssertEqual(manifest.privacyPolicyURL, "https://publisher.example/privacy")
        XCTAssertEqual(manifest.iconText, "GH")

        let rejectedManifests = [
            displayManifest.replacingOccurrences(of: "https://publisher.example/terms", with: "http://publisher.example/terms"),
            displayManifest.replacingOccurrences(of: "\"iconText\": \"GH\"", with: "\"iconText\": \"  \""),
            displayManifest.replacingOccurrences(of: "\"iconText\": \"GH\"", with: "\"iconURL\": \"https://publisher.example/icon.png\""),
        ]
        for rejectedManifest in rejectedManifests {
            XCTAssertThrowsError(try PluginManifestValidator.validate(
                manifestJSON: rejectedManifest,
                expectedDigest: digest,
                computedDigest: digest,
                revoked: false
            ))
        }
    }

    func testPluginManifestValidatorFailsClosedMatrix() throws {
        let fixture = try String(
            contentsOf: try pluginFixtureDirectory().appendingPathComponent("github.json"),
            encoding: .utf8
        )
        let digest = "sha256:" + String(repeating: "a", count: 64)
        let mutations = [
            fixture.replacingOccurrences(of: "2025-06-18", with: "2099-01-01"),
            fixture.replacingOccurrences(of: "\"risk\": \"read\"", with: "\"risk\": \"future-risk\""),
            fixture.replacingOccurrences(of: "\"approvalPolicy\": \"none\"", with: "\"approvalPolicy\": \"maybe\""),
            fixture.replacingOccurrences(of: "\"additionalProperties\": false", with: "\"additionalProperties\": true"),
            fixture.replacingOccurrences(of: "\"spdx\": \"MIT\"", with: "\"spdx\": \"GPL-3.0-only\""),
            fixture.replacingOccurrences(of: "\"publisher\": {", with: "\"access_token\": \"must-not-enter\", \"publisher\": {")
        ]
        for mutation in mutations {
            XCTAssertThrowsError(try PluginManifestValidator.validate(
                manifestJSON: mutation,
                expectedDigest: digest,
                computedDigest: digest,
                revoked: false
            ))
        }
        XCTAssertThrowsError(try PluginManifestValidator.validate(
            manifestJSON: fixture,
            expectedDigest: digest,
            computedDigest: "sha256:" + String(repeating: "b", count: 64),
            revoked: false
        ))
        XCTAssertThrowsError(try PluginManifestValidator.validate(
            manifestJSON: fixture,
            expectedDigest: digest,
            computedDigest: digest,
            revoked: true
        ))
        XCTAssertThrowsError(try PluginManifestValidator.validate(
            manifestJSON: "{not-json",
            expectedDigest: digest,
            computedDigest: digest,
            revoked: false
        ))

        let relativeRemote = fixture.replacingOccurrences(
            of: "https://api.githubcopilot.com/mcp/",
            with: "/v1/mcp/drive"
        )
        XCTAssertThrowsError(try PluginManifestValidator.validate(
            manifestJSON: relativeRemote,
            expectedDigest: digest,
            computedDigest: digest,
            revoked: false
        ))
    }

    func testDriveBackendStubAndStrictEnvironmentContract() async throws {
        XCTAssertNoThrow(try DriveBackendFactory.validateForBoot(
            environmentName: "local",
            environment: ["MOMO_DRIVE_BACKEND": "stub"]
        ))
        XCTAssertThrowsError(try DriveBackendFactory.validateForBoot(
            environmentName: "production",
            environment: ["MOMO_DRIVE_BACKEND": "stub"]
        ))

        let stub = StubDriveBackend()
        let search = try await stub.searchFiles(query: "handbook", pageSize: 10)
        XCTAssertEqual(search.objectValue?["files"]?.arrayValue?.count, 1)
        let metadata = try await stub.fileMetadata(fileID: "stub-text-1")
        XCTAssertEqual(metadata.objectValue?["name"]?.stringValue, "readme.txt")
        let exported = try await stub.exportText(fileID: "stub-doc-1", maxBytes: 1000)
        XCTAssertEqual(exported.objectValue?["text"]?.stringValue, "momo Drive stub document")
        do {
            _ = try await stub.exportText(fileID: "stub-doc-1", maxBytes: 2)
            XCTFail("stub export must enforce maxBytes")
        } catch {
            XCTAssertEqual(error as? DriveBackendError, .contentTooLarge)
        }
        XCTAssertNoThrow(try GoogleDriveSABackend.requireFileID("valid_file-ID_1"))
        XCTAssertThrowsError(try GoogleDriveSABackend.requireFileID("../outside"))

        let toolNames = DriveMCPToolRegistry.tools.compactMap {
            $0.objectValue?["name"]?.stringValue
        }
        XCTAssertEqual(toolNames, [
            "drive.search_files", "drive.get_file_metadata", "drive.export_text",
        ])
    }

    func testDriveArchiveStubAndStrictEnvironmentContract() async throws {
        XCTAssertNoThrow(try DriveArchiveClientFactory.validateForBoot(
            environmentName: "local",
            environment: ["MOMO_DRIVE_ARCHIVE_BACKEND": "stub"]
        ))
        XCTAssertThrowsError(try DriveArchiveClientFactory.validateForBoot(
            environmentName: "production",
            environment: ["MOMO_DRIVE_ARCHIVE_BACKEND": "stub"]
        ))
        XCTAssertThrowsError(try DriveArchiveClientFactory.validateForBoot(
            environmentName: "internal-host",
            environment: ["MOMO_DRIVE_BACKEND": "stub"]
        ))

        let stub = StubDriveArchiveClient(baseURL: "http://127.0.0.1:8080/")
        let channelID = UUID()
        let payload = Data("momo attachment".utf8)
        let session = try await stub.createResumableUpload(
            channelID: channelID,
            name: "note.txt",
            mime: "text/plain",
            sizeBytes: Int64(payload.count)
        )
        XCTAssertTrue(session.uploadURL.hasPrefix("http://127.0.0.1:8080/__momo_stub/"))
        let token = try XCTUnwrap(session.uploadURL.split(separator: "/").last.map(String.init))
        try await stub.acceptStubUpload(token: token, mime: "text/plain", bytes: payload)
        let metadata = try await stub.fileMetadata(fileID: session.driveFileID)
        XCTAssertEqual(metadata.name, "note.txt")
        XCTAssertEqual(metadata.mime, "text/plain")
        XCTAssertEqual(metadata.sizeBytes, Int64(payload.count))
        let content = try await stub.fileContent(fileID: session.driveFileID, maxBytes: 100)
        XCTAssertEqual(content.mime, "text/plain")
        XCTAssertEqual(content.sizeBytes, payload.count)

        let mismatch = try await stub.createResumableUpload(
            channelID: channelID, name: "bad.bin", mime: "application/octet-stream", sizeBytes: 3
        )
        let mismatchToken = try XCTUnwrap(
            mismatch.uploadURL.split(separator: "/").last.map(String.init)
        )
        do {
            try await stub.acceptStubUpload(
                token: mismatchToken, mime: "application/octet-stream", bytes: Data([1, 2])
            )
            XCTFail("stub must enforce the resumable session size")
        } catch {
            XCTAssertEqual(
                error as? DriveArchiveError,
                .invalidArguments("uploaded size does not match the session")
            )
        }
    }

    func testS3SigV4MatchesAWSPresignedURLVector() throws {
        // AWS S3 Developer Guide, "Authenticating Requests: Using Query
        // Parameters", Example 1 (2013-05-24, GET /test.txt).
        let config = S3ArchiveConfiguration(
            endpoint: try XCTUnwrap(URL(string: "https://s3.amazonaws.com")),
            region: "us-east-1",
            bucket: "examplebucket",
            accessKey: "AKIAIOSFODNN7EXAMPLE",
            secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            forcePathStyle: false
        )
        let now = try XCTUnwrap(
            ISO8601DateFormatter().date(from: "2013-05-24T00:00:00Z")
        )
        let url = try S3ArchiveSigner(configuration: config).presignedURL(
            method: "GET", objectKey: "test.txt", now: now, expires: 86_400
        )
        XCTAssertEqual(
            url.absoluteString,
            "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404&X-Amz-SignedHeaders=host"
        )
    }

    func testS3PresignExpirationAndPathStyleContract() throws {
        let environment = [
            "MOMO_S3_ENDPOINT": "http://minio:9000",
            "MOMO_S3_REGION": "us-east-1",
            "MOMO_S3_BUCKET": "momo-attachments",
            "MOMO_S3_ACCESS_KEY": "placeholder-access",
            "MOMO_S3_SECRET_KEY": "placeholder-secret",
            "MOMO_S3_FORCE_PATH_STYLE": "1",
        ]
        let config = try XCTUnwrap(S3ArchiveConfiguration.load(environment))
        XCTAssertTrue(config.forcePathStyle)
        let signer = S3ArchiveSigner(configuration: config)
        let now = try XCTUnwrap(
            ISO8601DateFormatter().date(from: "2026-07-21T00:00:00Z")
        )
        let url = try signer.presignedURL(
            method: "PUT",
            objectKey: "channels/00000000-0000-7000-8000-000000000201/object",
            now: now
        )
        XCTAssertEqual(
            url.path,
            "/momo-attachments/channels/00000000-0000-7000-8000-000000000201/object"
        )
        XCTAssertEqual(url.host, "minio")
        XCTAssertEqual(url.port, 9000)
        let query = Dictionary(uniqueKeysWithValues: try XCTUnwrap(
            URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        ).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(query["X-Amz-Expires"], String(S3ArchiveSigner.defaultExpirationSeconds))
        XCTAssertEqual(query["X-Amz-Date"], "20260721T000000Z")
        XCTAssertEqual(query["X-Amz-SignedHeaders"], "host")
        XCTAssertNotNil(query["X-Amz-Signature"])
        XCTAssertThrowsError(try signer.presignedURL(
            method: "PUT", objectKey: "object", now: now, expires: 604_801
        ))
    }

    func testS3ConfigurationFailsClosedWhenCredentialsAreIncomplete() throws {
        XCTAssertNil(S3ArchiveConfiguration.load([
            "MOMO_S3_ENDPOINT": "https://s3.us-east-1.amazonaws.com",
            "MOMO_S3_REGION": "us-east-1",
            "MOMO_S3_BUCKET": "momo-attachments",
            "MOMO_S3_ACCESS_KEY": "placeholder-access",
        ]))
        XCTAssertNoThrow(try ArchiveClientFactory.validateForBoot(
            environmentName: "production",
            environment: ["MOMO_ARCHIVE_BACKEND": "s3"]
        ))
        XCTAssertThrowsError(try ArchiveClientFactory.validateForBoot(
            environmentName: "production",
            environment: [
                "MOMO_ARCHIVE_BACKEND": "drive",
                "MOMO_DRIVE_ARCHIVE_BACKEND": "stub",
            ]
        ))
    }

    func testAttachmentMigrationAndMessageBindingStaticContracts() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let migration = try String(
            contentsOf: serverRoot.appendingPathComponent("Migrations/017_attachment.sql"),
            encoding: .utf8
        )
        XCTAssertTrue(migration.contains("CREATE TABLE attachment"))
        XCTAssertTrue(migration.contains("size_bytes BETWEEN 0 AND 104857600"))
        XCTAssertTrue(migration.contains("status IN ('pending', 'complete', 'failed')"))
        XCTAssertTrue(migration.contains("attachment_pending_cleanup_idx"))
        XCTAssertTrue(migration.contains("FORCE ROW LEVEL SECURITY"))

        let routes = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Routes/AttachmentRoutes.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(routes.contains("active channel membership required"))
        XCTAssertTrue(routes.contains("INSERT INTO audit_log"))
        XCTAssertTrue(routes.contains("fileMetadata(fileID:"))
        XCTAssertTrue(routes.contains("archive.fileContent("))
        XCTAssertFalse(routes.contains("MOMO_DRIVE_SA_KEY_PATH"))

        let messages = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Routes/MessageRoutes.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(messages.contains("linkAttachments("))
        XCTAssertTrue(messages.contains("status == \"complete\""))
        XCTAssertTrue(messages.contains("uploader == uploaderMemberID"))
        XCTAssertTrue(messages.contains("UPDATE attachment SET message_id"))
        XCTAssertTrue(messages.contains("attachment.message_linked"))
    }

    func testDrivePluginMigrationDoesNotPersistCredentialMaterial() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let migration = try String(
            contentsOf: serverRoot.appendingPathComponent("Migrations/015_drive_mcp_plugin.sql"),
            encoding: .utf8
        )
        XCTAssertTrue(migration.contains("com.momo.plugins.drive"))
        XCTAssertTrue(migration.contains("\"hosted\":true"))
        XCTAssertTrue(migration.contains("\"url\":\"/v1/mcp/drive\""))
        XCTAssertFalse(migration.contains("private_key"))
        XCTAssertFalse(migration.contains("access_token"))
        XCTAssertFalse(migration.contains("shared_drive_id"))
    }

    func testHostedDriveDescriptorBecomesAbsoluteWithoutRelaxingRemoteHTTPS() throws {
        let fixture = try String(
            contentsOf: try pluginFixtureDirectory().appendingPathComponent("drive.json"),
            encoding: .utf8
        )
        let digest = "sha256:" + String(repeating: "a", count: 64)
        let manifest = try PluginManifestValidator.validate(
            manifestJSON: fixture,
            expectedDigest: digest,
            computedDigest: digest,
            revoked: false
        )
        let request = Request(
            head: HTTPRequest(
                method: .get,
                scheme: "http",
                authority: "127.0.0.1:20100",
                path: "/v1/workspaces/ws/plugins"
            ),
            body: .init(buffer: .init())
        )
        XCTAssertEqual(
            try PluginRoutes.descriptorURL(manifest: manifest, request: request, environment: [:]),
            "http://127.0.0.1:20100/v1/mcp/drive"
        )
        XCTAssertEqual(
            try PluginRoutes.descriptorURL(
                manifest: manifest,
                request: request,
                environment: ["PUBLIC_BASE_URL": "https://momo.example.com"]
            ),
            "https://momo.example.com/v1/mcp/drive"
        )
    }

    func testPluginRegistryMigrationAndCustodyAStaticContracts() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let migration = try String(
            contentsOf: serverRoot.appendingPathComponent("Migrations/013_plugin_registry.sql"),
            encoding: .utf8
        )
        XCTAssertTrue(migration.contains("plugin_grant_four_tuple_uniq"))
        XCTAssertTrue(migration.contains("UNIQUE (workspace_id, member_id, plugin_id, scope)"))
        XCTAssertTrue(migration.contains("'workspace_plugin_install','plugin_grant','plugin_capability_projection'"))
        XCTAssertTrue(migration.contains("FORCE ROW LEVEL SECURITY"))
        XCTAssertTrue(migration.contains("sha256(convert_to(manifest::text, 'UTF8'))"))
        XCTAssertTrue(migration.contains("https://api.githubcopilot.com/mcp/"))
        XCTAssertTrue(migration.contains("https://mcp.notion.com/mcp"))
        XCTAssertTrue(migration.contains("https://mcp.linear.app/mcp"))
        XCTAssertFalse(migration.contains("credential_ciphertext"))
        XCTAssertFalse(migration.contains("access_token     "))
        XCTAssertFalse(migration.contains("refresh_token    "))

        let route = try String(
            contentsOf: serverRoot.appendingPathComponent("Sources/MomoServer/Routes/PluginRoutes.swift"),
            encoding: .utf8
        )
        XCTAssertFalse(route.contains("logger.info"))
        XCTAssertFalse(route.contains("logger.debug"))
        XCTAssertFalse(route.contains("accessToken"))
        XCTAssertFalse(route.contains("refreshToken"))
    }

    func testPluginScopeValidationIsFailClosed() throws {
        XCTAssertEqual(try PluginRoutes.normalizedScope(" GitHub:Read "), "github:read")
        XCTAssertThrowsError(try PluginRoutes.normalizedScope(""))
        XCTAssertThrowsError(try PluginRoutes.normalizedScope("github read"))
        XCTAssertThrowsError(try PluginRoutes.normalizedScope("../secret"))
    }

    private func pluginFixtureDirectory() throws -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/plugin-manifests", isDirectory: true)
    }

    func testInviteRoleValidationDefaultsAndRejectsOwner() throws {
        XCTAssertEqual(try InviteRoutes.normalizedRole(nil), "member")
        XCTAssertEqual(try InviteRoutes.normalizedRole(" ADMIN "), "admin")
        XCTAssertEqual(try InviteRoutes.normalizedRole("guest"), "guest")
        XCTAssertThrowsError(try InviteRoutes.normalizedRole("owner"))
        XCTAssertThrowsError(try InviteRoutes.normalizedRole("agent"))
    }

    func testInviteMaxUsesValidationMatchesMigrationConstraint() throws {
        XCTAssertEqual(try InviteRoutes.validatedMaxUses(nil), 1)
        XCTAssertEqual(try InviteRoutes.validatedMaxUses(10_000), 10_000)
        XCTAssertThrowsError(try InviteRoutes.validatedMaxUses(0))
        XCTAssertThrowsError(try InviteRoutes.validatedMaxUses(10_001))
    }

    func testInviteExpiryAllowsDatabaseDefaultAndValidatesExplicitValue() throws {
        XCTAssertNil(try InviteRoutes.validatedExpiresAtMs(nil))
        let future = Int64(Date().timeIntervalSince1970 * 1000) + 60_000
        XCTAssertEqual(try InviteRoutes.validatedExpiresAtMs(future), future)
        XCTAssertThrowsError(try InviteRoutes.validatedExpiresAtMs(0))
    }

    func testWorkspaceNameValidationNormalizesHumanReadableNames() throws {
        XCTAssertEqual(try WorkspaceRoutes.normalizedName("  momo team  "), "momo team")
        XCTAssertEqual(try WorkspaceRoutes.normalizedName("  모모 작업실\n"), "모모 작업실")
        XCTAssertEqual(
            try WorkspaceRoutes.normalizedName(String(repeating: "a", count: 80)),
            String(repeating: "a", count: 80)
        )
    }

    func testWorkspaceNameValidationRejectsEmptyLongAndControlInput() {
        XCTAssertThrowsError(try WorkspaceRoutes.normalizedName("  \n"))
        XCTAssertThrowsError(try WorkspaceRoutes.normalizedName(String(repeating: "a", count: 81)))
        XCTAssertThrowsError(try WorkspaceRoutes.normalizedName("momo\u{0000}team"))
    }

    func testWorkspaceRootRLSAndInviteDiscoveryStaticContracts() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let migration = try String(
            contentsOf: serverRoot.appendingPathComponent("Migrations/009_workspace_tenant_rls.sql"),
            encoding: .utf8
        )
        XCTAssertTrue(migration.contains("ALTER TABLE workspace ENABLE ROW LEVEL SECURITY"))
        XCTAssertTrue(migration.contains("ALTER TABLE workspace FORCE ROW LEVEL SECURITY"))
        XCTAssertTrue(migration.contains("USING (id = current_setting('app.workspace_id', true)::uuid)"))
        XCTAssertTrue(migration.contains("WITH CHECK (id = current_setting('app.workspace_id', true)::uuid)"))
        XCTAssertTrue(migration.contains("SECURITY DEFINER"))
        XCTAssertTrue(migration.contains("SET search_path = pg_catalog"))
        XCTAssertTrue(migration.contains("w.deleted_at IS NULL"))
        XCTAssertTrue(migration.contains("public.digest(raw_code, 'sha256')"))
        XCTAssertTrue(migration.contains("CREATE SCHEMA momo_join_private"))
        XCTAssertFalse(migration.contains("CREATE SCHEMA IF NOT EXISTS momo_join_private"))
        XCTAssertFalse(migration.contains("CREATE OR REPLACE FUNCTION momo_join_private"))
        XCTAssertTrue(migration.contains("REVOKE ALL ON SCHEMA momo_join_private FROM PUBLIC"))
        XCTAssertTrue(migration.contains("REVOKE ALL ON FUNCTION momo_join_private.invite_workspace_id(text) FROM PUBLIC"))
        XCTAssertTrue(migration.contains("GRANT USAGE ON SCHEMA momo_join_private TO momo_app"))
        XCTAssertTrue(migration.contains("GRANT EXECUTE ON FUNCTION momo_join_private.invite_workspace_id(text) TO momo_app"))
        XCTAssertFalse(migration.contains("EXECUTE format"))

        let roleBootstrap = try String(
            contentsOf: serverRoot
                .deletingLastPathComponent()
                .appendingPathComponent("infra/e2e/bootstrap_roles.sql"),
            encoding: .utf8
        )
        XCTAssertTrue(roleBootstrap.contains("GRANT USAGE ON SCHEMA momo_join_private TO momo_app"))
        XCTAssertTrue(roleBootstrap.contains("GRANT EXECUTE ON FUNCTION momo_join_private.invite_workspace_id(text) TO momo_app"))
        XCTAssertTrue(roleBootstrap.contains("REVOKE ALL ON SCHEMA momo_join_private FROM PUBLIC, momo_relay, momo_worker"))
        XCTAssertTrue(roleBootstrap.contains(
            "REVOKE ALL ON FUNCTION momo_join_private.invite_workspace_id(text)\n  FROM PUBLIC, momo_relay, momo_worker"
        ))

        let joinSource = try String(
            contentsOf: serverRoot.appendingPathComponent("Sources/MomoServer/Routes/JoinRoutes.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(joinSource.contains("SELECT momo_join_private.invite_workspace_id(\\(code))"))
        XCTAssertTrue(joinSource.contains("withTenantConnection(\n            workspaceID: workspaceID"))
        XCTAssertFalse(joinSource.contains("SELECT id\n                  FROM workspace"))
        XCTAssertFalse(joinSource.contains("for workspaceID in workspaceIDs"))

        let productionMigrate = try String(
            contentsOf: serverRoot
                .deletingLastPathComponent()
                .appendingPathComponent("infra/prod/docker/internal-smoke-migrate.sh"),
            encoding: .utf8
        )
        let preflight = try XCTUnwrap(productionMigrate.range(of: "role_contract=$(psql"))
        let migrate = try XCTUnwrap(productionMigrate.range(of: "sh scripts/migrate.sh"))
        XCTAssertLessThan(preflight.lowerBound, migrate.lowerBound)
        XCTAssertTrue(productionMigrate.contains("MOMO_BOOTSTRAP_RUNTIME_ROLES must be exactly 0 or 1"))
        XCTAssertTrue(productionMigrate.contains("refusing to migrate"))
    }

    func testWorkspaceReadConsolidatesMembershipAndIdentityQuery() throws {
        let source = try String(
            contentsOf: URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("Sources/MomoServer/Routes/WorkspaceRoutes.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(source.contains("readWorkspaceForActiveMember"))
        XCTAssertTrue(source.contains("'workspaceExists', EXISTS"))
        XCTAssertTrue(source.contains("AND EXISTS (\n                            SELECT 1\n                              FROM workspace_membership AS wm"))
    }

    func testJoinIdentityValidationNormalizesInputs() throws {
        XCTAssertEqual(try JoinRoutes.normalizedEmail("  USER@Example.COM  "), "user@example.com")
        XCTAssertEqual(try JoinRoutes.normalizedDisplayName("  New Human  "), "New Human")
        XCTAssertEqual(try JoinRoutes.normalizedRequestedHandle(" New_Human-1 "), "new_human-1")
        XCTAssertEqual(try JoinRoutes.fallbackHandle(email: "new.human@example.com"), "new-human")
        XCTAssertEqual(try JoinRoutes.normalizedTimeZone(nil), "UTC")
        XCTAssertEqual(try JoinRoutes.normalizedTimeZone("Asia/Seoul"), "Asia/Seoul")
        XCTAssertEqual(try JoinRoutes.normalizedPassword("dev-password"), "dev-password")
    }

    func testJoinIdentityValidationRejectsBadInputs() throws {
        XCTAssertThrowsError(try JoinRoutes.normalizedEmail("missing-at"))
        XCTAssertThrowsError(try JoinRoutes.normalizedDisplayName("   "))
        XCTAssertThrowsError(try JoinRoutes.normalizedRequestedHandle("Owner!"))
        XCTAssertThrowsError(try JoinRoutes.normalizedTimeZone(String(repeating: "a", count: 65)))
        XCTAssertThrowsError(try JoinRoutes.normalizedPassword(nil))
        XCTAssertThrowsError(try JoinRoutes.normalizedPassword(""))
        XCTAssertThrowsError(try JoinRoutes.normalizedPassword(String(repeating: "a", count: 1025)))
    }

    func testPlatformReadScopeRequiresAllowlistAndSecret() {
        let admins = ["ops@momo.local"]

        XCTAssertFalse(AuthRoutes.shouldGrantPlatformRead(
            email: "ops@momo.local",
            platformAdminSecret: "anything",
            platformAdminEmails: admins,
            platformAdminLoginSecret: nil
        ))
        XCTAssertFalse(AuthRoutes.shouldGrantPlatformRead(
            email: "ops@momo.local",
            platformAdminSecret: nil,
            platformAdminEmails: admins,
            platformAdminLoginSecret: "secret"
        ))
        XCTAssertFalse(AuthRoutes.shouldGrantPlatformRead(
            email: "ops@momo.local",
            platformAdminSecret: "wrong",
            platformAdminEmails: admins,
            platformAdminLoginSecret: "secret"
        ))
        XCTAssertFalse(AuthRoutes.shouldGrantPlatformRead(
            email: "other@momo.local",
            platformAdminSecret: "secret",
            platformAdminEmails: admins,
            platformAdminLoginSecret: "secret"
        ))
        XCTAssertTrue(AuthRoutes.shouldGrantPlatformRead(
            email: "OPS@MOMO.LOCAL",
            platformAdminSecret: "secret",
            platformAdminEmails: admins,
            platformAdminLoginSecret: "secret"
        ))
    }

    func testPrivilegedRefreshDropsOnlyPrivilegedScopesWhenQualificationIsGone() {
        let previous = [
            "messages:write",
            "platform:read",
            "messages:read",
            CloudCreditRoutes.writeScope,
        ]

        XCTAssertEqual(
            AuthRoutes.refreshedScopes(previous: previous, remainsPrivileged: false),
            ["messages:write", "messages:read"],
            "named regression: allowlist removal must strip both privileged scopes"
        )
        XCTAssertEqual(
            AuthRoutes.refreshedScopes(previous: previous, remainsPrivileged: true),
            previous
        )
    }

    func testRealtimeTokenTTLIsClampedToShortWindow() {
        XCTAssertEqual(Config.clampedCentConnectionTokenTTL(-1), 60)
        XCTAssertEqual(Config.clampedCentConnectionTokenTTL(59), 60)
        XCTAssertEqual(Config.clampedCentConnectionTokenTTL(300), 300)
        XCTAssertEqual(Config.clampedCentConnectionTokenTTL(1_800), 1_800)
        XCTAssertEqual(Config.clampedCentConnectionTokenTTL(7_200), 1_800)
    }

    func testAgentProviderStatusIsRedactedAndMockVisible() throws {
        let provider = AgentProviderConfig(
            mode: .internalHostMock,
            hermesBaseURL: "http://user:password@mock-hermes:8088/v1?token=secret",
            hermesAPIKey: "change-me-hermes-bearer",
            model: "hermes-agent",
            agentHandle: "kim-intern",
            displayName: "김인턴",
            allowLocalLoopback: false
        )

        let status = provider.statusResponse()
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(status)) as? [String: Any]

        XCTAssertEqual(status.availability, "mock")
        XCTAssertEqual(status.endpointLabel, "http://mock-hermes:8088/v1")
        XCTAssertEqual(object?["mode"] as? String, "internal-host-mock")
        XCTAssertEqual(object?["availability"] as? String, "mock")
        XCTAssertNil(object?["degradedReason"] as? String)
        XCTAssertFalse(status.endpointLabel.contains("password"))
        XCTAssertFalse(status.endpointLabel.contains("secret"))
        XCTAssertFalse(status.keyConfigured)
    }

    func testExternalProviderStatusIncludesRedactedDegradedReason() throws {
        let provider = AgentProviderConfig(
            mode: .externalHermes,
            hermesBaseURL: "http://user:super-secret@localhost:8088/v1?token=raw",
            hermesAPIKey: "dev-insecure-hermes-bearer",
            model: "hermes-agent",
            agentHandle: "kim-intern",
            displayName: "김인턴",
            allowLocalLoopback: false
        )

        let status = provider.statusResponse()
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(status)) as? [String: Any]
        let reason = try XCTUnwrap(object?["degradedReason"] as? String)

        XCTAssertEqual(status.availability, "degraded")
        XCTAssertTrue(reason.contains("HERMES_BASE_URL"))
        XCTAssertTrue(reason.contains("HERMES_API_KEY"))
        XCTAssertFalse(reason.contains("super-secret"))
        XCTAssertFalse(reason.contains("raw"))
        XCTAssertFalse(reason.contains("dev-insecure-hermes-bearer"))
        XCTAssertFalse(status.endpointLabel.contains("super-secret"))
        XCTAssertFalse(status.endpointLabel.contains("raw"))
    }

    func testStrictServerProviderConfigFailsFastForUnsafeExternalConfig() {
        let provider = AgentProviderConfig(
            mode: .localMock,
            hermesBaseURL: "http://localhost:8088/v1",
            hermesAPIKey: "dev-insecure-hermes-bearer",
            model: "hermes-agent",
            agentHandle: "kim-intern",
            displayName: "김인턴",
            allowLocalLoopback: false
        )

        XCTAssertThrowsError(try provider.validateForBoot(environmentName: "prod")) { error in
            let text = String(describing: error)
            XCTAssertTrue(text.contains("external-hermes"))
            XCTAssertTrue(text.contains("HERMES_BASE_URL"))
            XCTAssertTrue(text.contains("HERMES_API_KEY"))
            XCTAssertFalse(text.contains("dev-insecure-hermes-bearer"))
        }
    }

    func testLocalExternalProviderAllowsLoopbackOnlyWithExplicitOptIn() throws {
        let provider = AgentProviderConfig(
            mode: .externalHermes,
            hermesBaseURL: "http://127.0.0.1:22683/v1",
            hermesAPIKey: "local-hermes-bearer",
            model: "gpt-4.1-mini-through-local-hermes",
            agentHandle: "kim-intern",
            displayName: "김인턴",
            allowLocalLoopback: true
        )

        XCTAssertNoThrow(try provider.validateForBoot(environmentName: "local"))
        XCTAssertEqual(provider.availability, "available")
        XCTAssertEqual(provider.endpointLabel, "http://127.0.0.1:22683/v1")
        XCTAssertNil(provider.statusResponse().degradedReason)
        XCTAssertThrowsError(try provider.validateForBoot(environmentName: "staging")) { error in
            let text = String(describing: error)
            XCTAssertTrue(text.contains("localhost"))
        }
    }

    func testNonLoopbackHTTPStillFailsFastForExternalProvider() {
        let provider = AgentProviderConfig(
            mode: .externalHermes,
            hermesBaseURL: "http://kim.example.net/v1",
            hermesAPIKey: "local-hermes-bearer",
            model: "hermes-agent",
            agentHandle: "kim-intern",
            displayName: "김인턴",
            allowLocalLoopback: true
        )

        XCTAssertThrowsError(try provider.validateForBoot(environmentName: "local")) { error in
            let text = String(describing: error)
            XCTAssertTrue(text.contains("https://"))
        }
    }

    func testAgentGatewayModeDefaultsToTokenAuthAndGatesLegacySecret() {
        let defaultGateway = AgentGatewayConfig.load(environment: [:])
        XCTAssertEqual(defaultGateway.mode, .worker)
        XCTAssertFalse(defaultGateway.enabled)
        XCTAssertFalse(defaultGateway.secretConfigured)
        XCTAssertFalse(defaultGateway.allowLegacySecret)

        var config = testServerConfig()
        config.agentGateway = AgentGatewayConfig(
            mode: .gateway,
            secret: "change-me-agent-gateway-secret"
        )
        XCTAssertNoThrow(try config.validateSecurityForBoot())

        config.agentGateway = AgentGatewayConfig(
            mode: .gateway,
            secret: "change-me-agent-gateway-secret",
            allowLegacySecret: true
        )
        XCTAssertThrowsError(try config.validateSecurityForBoot()) { error in
            let text = String(describing: error)
            XCTAssertTrue(text.contains("AGENT_GATEWAY_SECRET"))
            XCTAssertTrue(text.contains("MOMO_ALLOW_LEGACY_GATEWAY_SECRET"))
            XCTAssertFalse(text.contains("change-me-agent-gateway-secret"))
        }

        config.agentGateway = AgentGatewayConfig(
            mode: .gateway,
            secret: "momo-test-gateway-secret-000000000000000000000000",
            allowLegacySecret: true
        )
        XCTAssertNoThrow(try config.validateSecurityForBoot())
        XCTAssertTrue(config.agentGateway.legacySecretEnabled)
    }

    func testAgentRuntimeStatusReportsGatewayDeliveryModeWhenEnabled() {
        var workerConfig = testServerConfig()
        workerConfig.agentProvider = AgentProviderConfig(
            mode: .localMock,
            hermesBaseURL: "http://localhost:28188/v1",
            hermesAPIKey: "dev-insecure-hermes-bearer",
            model: "hermes-agent",
            agentHandle: "hermes",
            displayName: "Hermes",
            allowLocalLoopback: true
        )
        workerConfig.agentGateway = AgentGatewayConfig(mode: .worker, secret: "")

        XCTAssertEqual(workerConfig.agentRuntimeStatusResponse().mode, "local-mock")

        var gatewayConfig = workerConfig
        gatewayConfig.agentGateway = AgentGatewayConfig(
            mode: .gateway,
            secret: "momo-test-gateway-secret-000000000000000000000000"
        )
        let gatewayStatus = gatewayConfig.agentRuntimeStatusResponse()
        XCTAssertEqual(gatewayStatus.mode, "gateway")
        XCTAssertEqual(gatewayStatus.availability, "available")
        XCTAssertEqual(gatewayStatus.endpointLabel, "Hermes gateway platform adapter")
        XCTAssertTrue(gatewayStatus.keyConfigured)
        XCTAssertTrue(gatewayStatus.diagnostics.isEmpty)

        gatewayConfig.agentGateway = AgentGatewayConfig(
            mode: .gateway,
            secret: "change-me",
            allowLegacySecret: true
        )
        let degraded = gatewayConfig.agentRuntimeStatusResponse()
        XCTAssertEqual(degraded.mode, "gateway")
        XCTAssertEqual(degraded.availability, "degraded")
        XCTAssertFalse(degraded.keyConfigured)
        XCTAssertEqual(degraded.diagnostics, [
            "AGENT_GATEWAY_SECRET is required when MOMO_ALLOW_LEGACY_GATEWAY_SECRET=1"
        ])
    }

    func testAgentBearerEnvelopeCarriesOnlyTenantRoutingHint() throws {
        let workspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let first = AgentBearerToken.mint(workspaceID: workspaceID)
        let second = AgentBearerToken.mint(workspaceID: workspaceID)

        XCTAssertNotEqual(first, second)
        XCTAssertEqual(AgentBearerToken.workspaceID(from: first), workspaceID)
        XCTAssertNil(AgentBearerToken.workspaceID(from: "momo_agent_v1.bad.short"))
        XCTAssertEqual(first.split(separator: ".").count, 3)
        XCTAssertFalse(first.contains("000000000103"), "actor id must come from the token row")
    }

    func testAgentBearerRouteScopesAreFailClosed() {
        XCTAssertEqual(
            AuthMiddleware.requiredAgentScope(method: "POST", path: "/v1/auth/realtime-token"),
            "realtime:subscribe"
        )
        XCTAssertEqual(
            AuthMiddleware.requiredAgentScope(
                method: "POST",
                path: "/v1/workspaces/ws/channels/ch/messages"
            ),
            "messages:write"
        )
        XCTAssertEqual(
            AuthMiddleware.requiredAgentScope(
                method: "GET",
                path: "/v1/workspaces/ws/read-state"
            ),
            "messages:read"
        )
        XCTAssertEqual(
            AuthMiddleware.requiredAgentScope(method: "POST", path: "/v1/mcp/drive"),
            "messages:read"
        )
        XCTAssertEqual(
            AuthMiddleware.requiredAgentScope(
                method: "GET",
                path: "/v1/workspaces/ws/plugins"
            ),
            "messages:read"
        )
        XCTAssertEqual(
            AuthMiddleware.requiredAgentScope(
                method: "PUT",
                path: "/v1/workspaces/ws/channels/ch/read-state"
            ),
            "messages:read"
        )
        XCTAssertEqual(
            AuthMiddleware.requiredAgentScope(
                method: "GET",
                path: "/v1/workspaces/ws/agents/agent/gateway/jobs/pending"
            ),
            "agent:jobs:read"
        )
        XCTAssertEqual(
            AuthMiddleware.requiredAgentScope(
                method: "POST",
                path: "/v1/workspaces/ws/agents/agent/gateway/jobs/341/lease/renew"
            ),
            "agent:jobs:read"
        )
        XCTAssertEqual(
            AuthMiddleware.requiredAgentScope(
                method: "POST",
                path: "/v1/workspaces/ws/agents/agent/gateway/jobs/341/lease/release"
            ),
            "agent:jobs:read"
        )
        XCTAssertEqual(
            AuthMiddleware.requiredAgentScope(
                method: "POST",
                path: "/v1/workspaces/ws/agent-runs/run/gateway/complete"
            ),
            "agent:runs:callback"
        )
        XCTAssertNil(AuthMiddleware.requiredAgentScope(
            method: "GET",
            path: "/v1/workspaces/ws/members"
        ))
        XCTAssertNil(AuthMiddleware.requiredAgentScope(
            method: "POST",
            path: "/v1/workspaces/ws/agents/agent/credentials"
        ))
        XCTAssertNil(AuthMiddleware.requiredAgentScope(
            method: "POST",
            path: "/v1/workspaces/ws/channels/ch/agent-runs"
        ))
        XCTAssertNil(AuthMiddleware.requiredAgentScope(
            method: "GET",
            path: "/v1/workspaces/ws/agent-runs/run"
        ))
        XCTAssertNil(AuthMiddleware.requiredAgentScope(
            method: "POST",
            path: "/v1/admin/messages"
        ))
    }

    func testAgentCredentialValidationDefaultsAndRejectsPrivilegeExpansion() throws {
        XCTAssertEqual(
            try AgentCredentialRoutes.normalizedScopes(nil),
            AgentCredentialRoutes.defaultScopes
        )
        XCTAssertEqual(
            try AgentCredentialRoutes.normalizedScopes([
                " messages:write ", "messages:write", "realtime:subscribe",
            ]),
            ["messages:write", "realtime:subscribe"]
        )
        XCTAssertThrowsError(try AgentCredentialRoutes.normalizedScopes([]))
        XCTAssertThrowsError(try AgentCredentialRoutes.normalizedScopes(["platform:read"]))
        XCTAssertEqual(try AgentCredentialRoutes.validatedRotationGraceSeconds(nil), 86_400)
        XCTAssertEqual(try AgentCredentialRoutes.validatedRotationGraceSeconds(0), 0)
        XCTAssertThrowsError(try AgentCredentialRoutes.validatedRotationGraceSeconds(-1))
        XCTAssertThrowsError(try AgentCredentialRoutes.validatedRotationGraceSeconds(
            AgentCredentialRoutes.maximumRotationGraceSeconds + 1
        ))
        XCTAssertEqual(try AgentCredentialRoutes.normalizedLabel(nil), "agent bearer")
    }

    func testAgentCreationValidationReusesProviderAndCredentialBoundary() throws {
        XCTAssertEqual(try AgentRoutes.normalizedModel("  hermes-agent  "), "hermes-agent")
        XCTAssertThrowsError(try AgentRoutes.normalizedModel("   "))
        XCTAssertEqual(
            try AgentRoutes.validatedBaseURL(
                " http://127.0.0.1:28188/v1 ",
                environmentName: "local",
                allowLocalLoopback: true
            ),
            "http://127.0.0.1:28188/v1"
        )
        XCTAssertEqual(
            try AgentRoutes.validatedBaseURL(
                "https://hermes.example.net/v1",
                environmentName: "prod",
                allowLocalLoopback: false
            ),
            "https://hermes.example.net/v1"
        )
        XCTAssertThrowsError(try AgentRoutes.validatedBaseURL(
            "http://hermes.example.net/v1",
            environmentName: "local",
            allowLocalLoopback: true
        ))
        XCTAssertThrowsError(try AgentRoutes.validatedBaseURL(
            "http://127.0.0.1/v1",
            environmentName: "local",
            allowLocalLoopback: true
        ))
        XCTAssertThrowsError(try AgentRoutes.validatedBaseURL(
            "https://user:secret@hermes.example.net/v1?api_key=secret",
            environmentName: "prod",
            allowLocalLoopback: false
        ))
        XCTAssertThrowsError(try AgentRoutes.validatedConfig([
            "nested": .object(["openai_api_key": .string("never-ingest")]),
        ]))
        XCTAssertThrowsError(try AgentRoutes.validatedConfig([
            "provider": .object(["apiKey": .string("never-ingest")]),
        ]))
        XCTAssertThrowsError(try AgentRoutes.validatedConfig([
            "provider": .object(["refresh-token": .string("never-ingest")]),
        ]))
        XCTAssertNoThrow(try AgentRoutes.validatedConfig([
            "temperature": .double(0.2),
            "max_tokens": .int(2048),
        ]))
    }

    func testAgentCreationRequestRejectsUnknownCredentialFields() throws {
        let valid = Data(#"{"displayName":"Hermes","handle":"hermes","model":"hermes-agent","baseUrl":"https://hermes.example.net/v1"}"#.utf8)
        XCTAssertNoThrow(try JSONDecoder().decode(CreateAgentRequest.self, from: valid))

        let providerKey = Data(#"{"displayName":"Hermes","handle":"hermes","model":"hermes-agent","baseUrl":"https://hermes.example.net/v1","apiKey":"must-stay-provider-owned"}"#.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(CreateAgentRequest.self, from: providerKey))
    }

    func testLifecycleCompletionRoutesKeepSelfLeaveAndAgentSymmetryAtomic() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let lifecycle = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Routes/MemberLifecycleRoutes.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(lifecycle.contains("channels/:ch/members/me"))
        XCTAssertTrue(lifecycle.contains("members/me"))
        XCTAssertTrue(lifecycle.contains("direct message channels cannot be left"))
        XCTAssertTrue(lifecycle.contains("SET archived_at = COALESCE(archived_at, now())"))
        XCTAssertTrue(lifecycle.contains("WorkspaceAuthorization.requireMember"))
        XCTAssertTrue(lifecycle.contains("WorkspaceAuthorization.lockMembershipMutation"))
        XCTAssertTrue(lifecycle.contains("workspace must retain at least one owner"))
        XCTAssertTrue(lifecycle.contains("RETURNING kind::text"))
        XCTAssertTrue(lifecycle.contains("agent_credentials_revoked"))
        XCTAssertTrue(lifecycle.contains("credentials_restored"))
        XCTAssertFalse(lifecycle.contains("BYPASSRLS"))

        let agentRoutes = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Routes/AgentRoutes.swift"
            ),
            encoding: .utf8
        )
        let credentials = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Routes/AgentCredentialRoutes.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(agentRoutes.contains("JoinRoutes.requireNotBanned"))
        XCTAssertTrue(credentials.contains("requireUnbannedHandle: true"))
        XCTAssertTrue(credentials.contains("JoinRoutes.requireNotBanned"))
    }

    func testAuditFiltersValidatePrefixesMemberTimeCursorAndLimit() throws {
        let memberID = UUID(uuidString: "00000000-0000-7000-8000-000000000104")!
        let cursorID = UUID(uuidString: "00000000-0000-7000-8000-000000000572")!
        let filters = try AuditRoutes.filters(
            actions: " member., ban.created ",
            targetMember: memberID.uuidString,
            fromMs: "1000",
            toMs: "2000",
            cursor: cursorID.uuidString,
            limit: "25"
        )
        XCTAssertEqual(filters.actionPrefixes, ["member.", "ban.created"])
        XCTAssertEqual(filters.targetMember, memberID)
        XCTAssertEqual(filters.fromMs, 1000)
        XCTAssertEqual(filters.toMs, 2000)
        XCTAssertEqual(filters.cursor, cursorID)
        XCTAssertEqual(filters.limit, 25)
        XCTAssertEqual(
            try AuditRoutes.filters(
                actions: nil, targetMember: nil, fromMs: nil, toMs: nil,
                cursor: nil, limit: nil
            ).limit,
            50
        )
        XCTAssertThrowsError(try AuditRoutes.filters(
            actions: "member.,", targetMember: nil, fromMs: nil, toMs: nil,
            cursor: nil, limit: nil
        ))
        XCTAssertThrowsError(try AuditRoutes.filters(
            actions: nil, targetMember: "bad", fromMs: nil, toMs: nil,
            cursor: nil, limit: nil
        ))
        XCTAssertThrowsError(try AuditRoutes.filters(
            actions: nil, targetMember: nil, fromMs: "2000", toMs: "1000",
            cursor: nil, limit: nil
        ))
        XCTAssertThrowsError(try AuditRoutes.filters(
            actions: nil, targetMember: nil, fromMs: nil, toMs: nil,
            cursor: "bad", limit: "201"
        ))
    }

    func testAuditRouteUsesCentralAdminRLSAndStableKeysetCursor() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let routes = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Routes/AuditRoutes.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(routes.contains("WorkspaceAuthorization.requireAdmin"))
        XCTAssertTrue(routes.contains("withTenantConnection"))
        XCTAssertTrue(routes.contains("ORDER BY a.created_at DESC, a.id DESC"))
        XCTAssertTrue(routes.contains("a.subject_member_id"))
        XCTAssertTrue(routes.contains("unnest(\\(filters.actionPrefixes)::text[])"))
        XCTAssertTrue(routes.contains("\\(filters.targetMember)::uuid"))
        XCTAssertTrue(routes.contains("\\(filters.cursor)::uuid"))
        XCTAssertFalse(routes.contains("BYPASSRLS"))
    }

    func testAgentGatewayErrorSanitizerRedactsSecretsAndCredentialShapedText() {
        XCTAssertNil(AgentGatewayRoutes.sanitizedGatewayError("   ", gatewaySecret: "secret"))
        XCTAssertEqual(
            AgentGatewayRoutes.sanitizedGatewayError(
                "gateway secret secret leaked", gatewaySecret: "secret"),
            "gateway [redacted] [redacted] leaked"
        )
        XCTAssertEqual(
            AgentGatewayRoutes.sanitizedGatewayError(
                "Authorization: Bearer sk-test", gatewaySecret: ""),
            "Hermes gateway reported an error with redacted credential-shaped content."
        )
        XCTAssertEqual(
            AgentGatewayRoutes.sanitizedGatewayError(
                "provider echoed momo_agent_v1.workspace.secret-value", gatewaySecret: ""),
            "provider echoed [redacted-agent-token]"
        )
        XCTAssertEqual(
            AgentGatewayRoutes.sanitizedGatewayError(
                "provider sk-proj-abcdefghijklmnop jwt eyJheader12.eyJpayload12.signature12",
                gatewaySecret: ""
            ),
            "provider [redacted-provider-token] jwt [redacted-jwt]"
        )
        let long = String(repeating: "x", count: 1_010)
        XCTAssertTrue(
            AgentGatewayRoutes.sanitizedGatewayError(long, gatewaySecret: "")?
                .hasSuffix("... [truncated]") == true
        )
    }

    func testAgentGatewayCompletionStatusFailsClosedForErrorsAndUnknownValues() throws {
        XCTAssertEqual(
            try AgentGatewayRoutes.normalizedCompletionStatus(nil, error: "provider failed"),
            "failed"
        )
        XCTAssertEqual(
            try AgentGatewayRoutes.normalizedCompletionStatus(nil, error: nil),
            "succeeded"
        )
        XCTAssertThrowsError(
            try AgentGatewayRoutes.normalizedCompletionStatus(
                "succeeded", error: "conflicting provider failure"
            )
        )
        XCTAssertThrowsError(
            try AgentGatewayRoutes.normalizedCompletionStatus("mystery", error: nil)
        )
        XCTAssertFalse(AgentGatewayRoutes.isTerminalRunStatus("awaiting_approval"))
        XCTAssertTrue(AgentGatewayRoutes.isTerminalRunStatus("cancelled"))
        XCTAssertTrue(AgentGatewayRoutes.isTerminalRunStatus("timed_out"))
        XCTAssertTrue(AgentGatewayRoutes.isApprovalHeldRunStatus("awaiting_approval"))
        XCTAssertFalse(AgentGatewayRoutes.isApprovalHeldRunStatus("queued"))
    }

    func testAgentGatewayCompletionRejectsApprovalHeldRunBeforeLeaseValidation() {
        XCTAssertEqual(
            AgentGatewayRoutes.completionPreLeaseDisposition(for: "awaiting_approval"),
            .approvalHeld
        )
        XCTAssertEqual(
            AgentGatewayRoutes.completionPreLeaseDisposition(for: "paused"),
            .approvalHeld
        )
        for status in ["queued", "running", "succeeded", "failed", "cancelled", "timed_out"] {
            XCTAssertEqual(
                AgentGatewayRoutes.completionPreLeaseDisposition(for: status),
                .requireLease,
                "\(status) must retain exact-owner lease validation"
            )
        }
    }

    func testAgentGatewayProgressEventsDecodeWithBoundedStreamingDelta() throws {
        let eventID = UUID(uuidString: "00000000-0000-7350-8000-000000350001")!
        let thinking = try JSONDecoder().decode(
            AgentGatewayEventRequest.self,
            from: Data(#"{"event_id":"\#(eventID.uuidString)","status":"thinking","detail":"reading context"}"#.utf8)
        ).validatedProgress(status: "thinking")
        XCTAssertEqual(thinking.eventID, eventID)
        XCTAssertEqual(thinking.detail, "reading context")
        XCTAssertNil(thinking.textDelta)

        let streaming = try JSONDecoder().decode(
            AgentGatewayEventRequest.self,
            from: Data(#"{"event_id":"\#(eventID.uuidString)","status":"streaming","text_delta":"안녕"}"#.utf8)
        ).validatedProgress(status: "streaming")
        XCTAssertEqual(streaming.textDelta, "안녕")
    }

    func testAgentGatewayWorkToolCallBuildsCanonicalControlRequest() throws {
        let targetHostID = UUID()
        let channelID = UUID()
        let runID = UUID()
        let data = Data(
            """
            {
              "job_id": 341,
              "lease_id": "00000000-0000-7350-8000-000000000341",
              "status": "tool_call",
              "tool_call": {
                "call_id": "call-work-spawn-1",
                "name": "work.spawn",
                "target_host_id": "\(targetHostID.uuidString)",
                "arguments": {"tool":"codex","label":"Fix gateway parity"}
              }
            }
            """.utf8
        )
        let event = try JSONDecoder().decode(AgentGatewayEventRequest.self, from: data)
        let call = try XCTUnwrap(event.toolCall).validated()
        let request = try call.createRequest(channelID: channelID, runID: runID)

        XCTAssertEqual(call.callId, "call-work-spawn-1")
        XCTAssertEqual(call.name, "work.spawn")
        XCTAssertEqual(request.channelId, channelID)
        XCTAssertEqual(request.runId, runID)
        XCTAssertEqual(request.targetHostId, targetHostID)
        XCTAssertNil(request.sessionId)
        XCTAssertEqual(request.kind, "spawn")
        XCTAssertEqual(
            request.payload,
            .object(["tool": .string("codex"), "label": .string("Fix gateway parity")])
        )
    }

    func testAgentGatewayWorkToolCallMapsSessionControlsAndRejectsWidening() throws {
        let targetHostID = UUID()
        let sessionID = UUID()
        let channelID = UUID()
        let runID = UUID()

        func call(name: String, arguments: String) throws -> AgentGatewayWorkToolCall {
            let data = Data(
                """
                {
                  "call_id":"call-1",
                  "name":"\(name)",
                  "target_host_id":"\(targetHostID.uuidString)",
                  "arguments":\(arguments)
                }
                """.utf8
            )
            return try JSONDecoder().decode(AgentGatewayWorkToolCall.self, from: data)
                .validated()
        }

        let input = try call(
            name: "work.input",
            arguments: "{\"session_id\":\"\(sessionID.uuidString)\",\"text\":\"continue\"}"
        ).createRequest(channelID: channelID, runID: runID)
        XCTAssertEqual(input.kind, "input")
        XCTAssertEqual(input.sessionId, sessionID)
        XCTAssertEqual(input.payload, .object(["text": .string("continue")]))

        let read = try call(
            name: "work.read",
            arguments: "{\"session_id\":\"\(sessionID.uuidString)\",\"tail_lines\":80}"
        ).createRequest(channelID: channelID, runID: runID)
        XCTAssertEqual(read.kind, "read")
        XCTAssertEqual(read.payload, .object(["tail_lines": .int(80)]))

        XCTAssertThrowsError(
            try call(
                name: "work.kill",
                arguments: "{\"session_id\":\"\(sessionID.uuidString)\",\"signal\":\"KILL\"}"
            ).createRequest(channelID: channelID, runID: runID)
        )
        XCTAssertThrowsError(
            try call(name: "shell", arguments: "{}").createRequest(
                channelID: channelID,
                runID: runID
            )
        )
    }

    func testAgentGatewayCallbacksRequireExactJobLeaseBinding() throws {
        let leaseID = UUID(uuidString: "00000000-0000-7341-8000-000000000341")!
        let event = try JSONDecoder().decode(
            AgentGatewayEventRequest.self,
            from: Data(
                #"{"job_id":341,"lease_id":"\#(leaseID.uuidString)","status":"running"}"#.utf8
            )
        )
        XCTAssertEqual(
            try event.validatedLease(),
            AgentGatewayLeaseBinding(jobID: 341, leaseID: leaseID)
        )

        let complete = try JSONDecoder().decode(
            AgentGatewayCompleteRequest.self,
            from: Data(
                #"{"job_id":341,"lease_id":"\#(leaseID.uuidString)","status":"succeeded"}"#.utf8
            )
        )
        XCTAssertEqual(
            try complete.validatedLease(),
            AgentGatewayLeaseBinding(jobID: 341, leaseID: leaseID)
        )

        let missing = try JSONDecoder().decode(
            AgentGatewayEventRequest.self,
            from: Data(#"{"status":"running"}"#.utf8)
        )
        XCTAssertThrowsError(try missing.validatedLease())

        let wrongPath = try JSONDecoder().decode(
            AgentGatewayLeaseRequest.self,
            from: Data(
                #"{"job_id":342,"lease_id":"\#(leaseID.uuidString)"}"#.utf8
            )
        )
        XCTAssertThrowsError(try wrongPath.validated(jobID: 341))
    }

    func testAgentGatewayConcurrentConsumersOnlyFirstClaimIsEligible() {
        let unclaimed = AgentGatewayRoutes.GatewayClaimSnapshot(
            status: "pending",
            available: true,
            leaseActive: false
        )
        XCTAssertTrue(AgentGatewayRoutes.gatewayClaimEligible(snapshot: unclaimed))

        let claimedByFirstConsumer = AgentGatewayRoutes.GatewayClaimSnapshot(
            status: "pending",
            available: true,
            leaseActive: true
        )
        XCTAssertFalse(
            AgentGatewayRoutes.gatewayClaimEligible(snapshot: claimedByFirstConsumer),
            "the second concurrent consumer must not start provider execution"
        )
    }

    func testAgentGatewayCrashExpiryEnablesTakeover() {
        let expiredOwner = AgentGatewayRoutes.GatewayClaimSnapshot(
            status: "pending",
            available: true,
            leaseActive: false
        )
        XCTAssertTrue(
            AgentGatewayRoutes.gatewayClaimEligible(snapshot: expiredOwner),
            "an expired crashed-owner lease must be takeover eligible"
        )

        let staleOwner = UUID(uuidString: "00000000-0000-7341-8000-000000000001")!
        let takeoverOwner = UUID(uuidString: "00000000-0000-7341-8000-000000000002")!
        let takenOver = AgentGatewayRoutes.GatewayLeaseSnapshot(
            status: "pending",
            owner: takeoverOwner,
            active: true
        )
        XCTAssertFalse(
            AgentGatewayRoutes.gatewayLeaseAuthorized(
                snapshot: takenOver,
                presentedLeaseID: staleOwner,
                allowSettled: false
            )
        )
        XCTAssertTrue(
            AgentGatewayRoutes.gatewayLeaseAuthorized(
                snapshot: takenOver,
                presentedLeaseID: takeoverOwner,
                allowSettled: false
            )
        )
    }

    func testAgentGatewayStaleOwnerEventCompleteRenewAndReleaseFailClosedAs409() {
        let staleOwner = UUID(uuidString: "00000000-0000-7341-8000-000000000011")!
        let currentOwner = UUID(uuidString: "00000000-0000-7341-8000-000000000012")!
        let snapshot = AgentGatewayRoutes.GatewayLeaseSnapshot(
            status: "pending",
            owner: currentOwner,
            active: true
        )

        for surface in ["events", "complete", "renew", "release"] {
            XCTAssertFalse(
                AgentGatewayRoutes.gatewayLeaseAuthorized(
                    snapshot: snapshot,
                    presentedLeaseID: staleOwner,
                    allowSettled: surface == "complete"
                ),
                "stale owner must be rejected by gateway \(surface)"
            )
        }

        XCTAssertThrowsError(try AgentGatewayRoutes.rejectGatewayLease()) { error in
            XCTAssertEqual((error as? HTTPError)?.status, .conflict)
        }
    }

    func testAgentGatewayExpiredLeaseCannotMutateAndCanBeReclaimed() {
        let owner = UUID(uuidString: "00000000-0000-7341-8000-000000000021")!
        let expired = AgentGatewayRoutes.GatewayLeaseSnapshot(
            status: "pending",
            owner: owner,
            active: false
        )
        XCTAssertFalse(
            AgentGatewayRoutes.gatewayLeaseAuthorized(
                snapshot: expired,
                presentedLeaseID: owner,
                allowSettled: false
            )
        )
        XCTAssertTrue(
            AgentGatewayRoutes.gatewayClaimEligible(
                snapshot: .init(status: "pending", available: true, leaseActive: false)
            )
        )
    }

    func testAgentGatewayMissingAndSettledLeasePolicyFailsClosed() {
        let owner = UUID(uuidString: "00000000-0000-7341-8000-000000000031")!
        XCTAssertFalse(
            AgentGatewayRoutes.gatewayLeaseAuthorized(
                snapshot: nil,
                presentedLeaseID: owner,
                allowSettled: false
            )
        )
        XCTAssertFalse(
            AgentGatewayRoutes.gatewayLeaseAuthorized(
                snapshot: .init(status: "pending", owner: nil, active: false),
                presentedLeaseID: owner,
                allowSettled: false
            )
        )
        let settled = AgentGatewayRoutes.GatewayLeaseSnapshot(
            status: "done",
            owner: owner,
            active: false
        )
        XCTAssertFalse(
            AgentGatewayRoutes.gatewayLeaseAuthorized(
                snapshot: settled,
                presentedLeaseID: owner,
                allowSettled: false
            )
        )
        XCTAssertTrue(
            AgentGatewayRoutes.gatewayLeaseAuthorized(
                snapshot: settled,
                presentedLeaseID: owner,
                allowSettled: true
            )
        )
    }

    func testAgentGatewayProgressEventsFailClosedOnShapeAndSize() throws {
        let missingDelta = try JSONDecoder().decode(
            AgentGatewayEventRequest.self,
            from: Data(#"{"status":"streaming"}"#.utf8)
        )
        XCTAssertThrowsError(try missingDelta.validatedProgress(status: "streaming"))

        let misplacedDelta = try JSONDecoder().decode(
            AgentGatewayEventRequest.self,
            from: Data(#"{"status":"thinking","text_delta":"forged"}"#.utf8)
        )
        XCTAssertThrowsError(try misplacedDelta.validatedProgress(status: "thinking"))

        let oversized = String(repeating: "x", count: AgentGatewayEventRequest.maximumTextDeltaBytes + 1)
        let data = try JSONSerialization.data(withJSONObject: [
            "status": "streaming",
            "text_delta": oversized,
        ])
        let request = try JSONDecoder().decode(AgentGatewayEventRequest.self, from: data)
        XCTAssertThrowsError(try request.validatedProgress(status: "streaming"))

        let unknown = try JSONDecoder().decode(
            AgentGatewayEventRequest.self,
            from: Data(#"{"status":"forged"}"#.utf8)
        )
        XCTAssertThrowsError(try unknown.validatedProgress(status: "forged"))
    }

    func testAgentGatewayProgressRateCapCannotBeDisabledByGeneralRateConfig() async {
        let limiter = SlidingWindowRateLimiter()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        for _ in 0..<AgentGatewayRoutes.maximumProgressEventsPerWindow {
            let verdict = await limiter.check(
                key: "gateway-progress:workspace:run",
                limit: AgentGatewayRoutes.maximumProgressEventsPerWindow,
                windowSeconds: AgentGatewayRoutes.progressRateWindowSeconds,
                now: now
            )
            XCTAssertTrue(verdict.allowed)
        }
        let rejected = await limiter.check(
            key: "gateway-progress:workspace:run",
            limit: AgentGatewayRoutes.maximumProgressEventsPerWindow,
            windowSeconds: AgentGatewayRoutes.progressRateWindowSeconds,
            now: now
        )
        XCTAssertFalse(rejected.allowed)
    }

    func testWorkRunInputValidatesExactShapeAndLeavesNonWorkInputsUntouched() throws {
        let input = JSONValue.object([
            "type": .string("work"),
            "title": .string("  Prepare release  "),
            "brief": .string("  Build, test, and open a PR.  "),
            "repo": .string("  Dawn-kim-official/momo  "),
            "branch": .string("  feat/work-surface  "),
        ])
        let work = try WorkRunInput.require(input)

        XCTAssertEqual(work.title, "Prepare release")
        XCTAssertEqual(work.brief, "Build, test, and open a PR.")
        XCTAssertEqual(work.repo, "Dawn-kim-official/momo")
        XCTAssertEqual(work.branch, "feat/work-surface")
        XCTAssertEqual(
            work.jsonValue.objectValue?["type"]?.stringValue,
            "work"
        )
        XCTAssertNil(try WorkRunInput.validateIfWork(.object([
            "surface": .string("mention"),
            "prompt": .string("existing non-work input"),
        ])))
        XCTAssertNil(try WorkRunInput.validateIfWork(.object([
            "type": .string("chat"),
            "prompt": .string("another convention"),
        ])))
    }

    func testWorkRunInputShapeFailuresAreBadRequests() throws {
        let invalidInputs: [JSONValue] = [
            .object(["type": .string("work"), "brief": .string("missing title")]),
            .object([
                "type": .string("work"),
                "title": .string("Title"),
                "brief": .string("   "),
            ]),
            .object([
                "type": .string("work"),
                "title": .string("Title"),
                "brief": .string("Brief"),
                "repo": .bool(true),
            ]),
            .object([
                "type": .string("work"),
                "title": .string("Title"),
                "brief": .string("Brief"),
                "command": .string("rm -rf /"),
            ]),
            .array([]),
        ]

        for input in invalidInputs {
            XCTAssertThrowsError(try WorkRunInput.require(input)) { error in
                XCTAssertEqual((error as? HTTPError)?.status, .badRequest)
            }
        }
    }

    func testCreateWorkRunRequestAcceptsCamelAndSnakeCaseBindings() throws {
        let camel = try JSONDecoder().decode(
            CreateAgentRunRequest.self,
            from: Data("""
            {
              "agentMemberId": "00000000-0000-7000-8000-000000000103",
              "clientRunId": "00000000-0000-7000-8000-000000000362",
              "input": {"type":"work","title":"Title","brief":"Brief"}
            }
            """.utf8)
        )
        let snake = try JSONDecoder().decode(
            CreateAgentRunRequest.self,
            from: Data("""
            {
              "agent_member_id": "00000000-0000-7000-8000-000000000103",
              "client_run_id": "00000000-0000-7000-8000-000000000362",
              "input": {"type":"work","title":"Title","brief":"Brief"}
            }
            """.utf8)
        )

        XCTAssertEqual(camel.agentMemberId, snake.agentMemberId)
        XCTAssertEqual(camel.clientRunId, snake.clientRunId)
        XCTAssertEqual(camel.input, snake.input)
    }

    func testApprovalTierAcceptsV0TiersAndRejectsDangerAs400() throws {
        XCTAssertEqual(try AgentGatewayApprovalTier.validated("read_only"), .readOnly)
        XCTAssertEqual(
            try AgentGatewayApprovalTier.validated("workspace_write"),
            .workspaceWrite
        )
        XCTAssertEqual(
            try AgentGatewayApprovalTier.validated("network_write"),
            .networkWrite
        )
        XCTAssertEqual(
            try AgentGatewayApprovalTier.validated(nil),
            .workspaceWrite,
            "MOMO-349 callbacks without tier remain approval-gated"
        )

        for denied in ["danger", "danger_full_access", "danger-full-access", "root"] {
            XCTAssertThrowsError(try AgentGatewayApprovalTier.validated(denied)) { error in
                XCTAssertEqual((error as? HTTPError)?.status, .badRequest)
            }
        }

        XCTAssertThrowsError(try JSONDecoder().decode(
            AgentGatewayApprovalRequest.self,
            from: Data("""
            {
              "tier": "danger_full_access",
              "tool_call": {"call_id":"call-danger","name":"shell","arguments":{}}
            }
            """.utf8)
        )) { error in
            XCTAssertEqual((error as? HTTPError)?.status, .badRequest)
        }
    }

    func testAgentRunReadAndGatewayCallbackRemainActorBound() throws {
        let first = UUID(uuidString: "00000000-0000-7000-8000-000000000103")!
        let second = UUID(uuidString: "00000000-0000-7000-8000-000000000104")!

        XCTAssertTrue(AgentGatewayRoutes.runActorBindingAllows(
            principalMemberID: first,
            runAgentMemberID: first
        ))
        XCTAssertFalse(AgentGatewayRoutes.runActorBindingAllows(
            principalMemberID: first,
            runAgentMemberID: second
        ))
        XCTAssertThrowsError(try AgentGatewayRoutes.rejectRunActorBinding()) { error in
            XCTAssertEqual((error as? HTTPError)?.status, .forbidden)
        }
        XCTAssertTrue(AgentRunRoutes.canReadRun(
            principalKind: .human,
            principalMemberID: first,
            runAgentMemberID: second,
            hasChannelMembership: true
        ))
        XCTAssertFalse(AgentRunRoutes.canReadRun(
            principalKind: .agent,
            principalMemberID: first,
            runAgentMemberID: second,
            hasChannelMembership: true
        ))
        XCTAssertFalse(AgentRunRoutes.canReadRun(
            principalKind: .human,
            principalMemberID: first,
            runAgentMemberID: second,
            hasChannelMembership: false
        ))
        for status in ["queued", "running", "awaiting_approval", "paused"] {
            XCTAssertTrue(AgentRunRoutes.isCancellableRunStatus(status))
        }
        for status in ["succeeded", "failed", "cancelled", "timed_out"] {
            XCTAssertFalse(AgentRunRoutes.isCancellableRunStatus(status))
        }
    }

    func testAgentGatewayApprovalRequestDecodesAndBuildsWorkerCompatiblePayload() throws {
        let json = """
        {
          "action_type": "tool_call",
          "tier": "network_write",
          "title": "Create release issue",
          "summary": "Review the issue before Hermes creates it.",
          "tool_call": {
            "call_id": "call-release-1",
            "name": "create_github_issue",
            "arguments": {"title": "Release checklist"},
            "tool_grant": {
              "tool_name": "create_github_issue",
              "approval_policy": "require_approval"
            }
          },
          "estimated_micro_usd": 1200,
          "is_reversible": false
        }
        """
        let request = try JSONDecoder().decode(
            AgentGatewayApprovalRequest.self,
            from: Data(json.utf8)
        ).validated()
        let runID = UUID(uuidString: "00000000-0000-7000-8000-000000000777")!
        let payload = AgentGatewayRoutes.approvalPayload(runID: runID, request: request)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any]
        )
        let toolCall = try XCTUnwrap(object["tool_call"] as? [String: Any])

        XCTAssertEqual(object["run_id"] as? String, runID.uuidString)
        XCTAssertEqual(object["resume_model"] as? String, "gateway_resume_agent_job")
        XCTAssertEqual(object["source"] as? String, "hermes_gateway")
        XCTAssertEqual(object["tier"] as? String, "network_write")
        XCTAssertEqual(request.tier, .networkWrite)
        XCTAssertEqual(object["estimated_micro_usd"] as? Int, 1200)
        XCTAssertEqual(object["is_reversible"] as? Bool, false)
        XCTAssertEqual(toolCall["call_id"] as? String, "call-release-1")
        XCTAssertEqual(toolCall["name"] as? String, "create_github_issue")
        XCTAssertEqual(
            (toolCall["arguments"] as? [String: Any])?["title"] as? String,
            "Release checklist"
        )
        XCTAssertEqual(
            (toolCall["tool_grant"] as? [String: Any])?["approval_policy"] as? String,
            "require_approval"
        )
    }

    func testAgentGatewayApprovalRequestValidationFailsClosed() throws {
        let missingCallID = """
        {
          "tool_call": {
            "call_id": "   ",
            "name": "create_github_issue",
            "arguments": {}
          }
        }
        """
        let malformedGrant = """
        {
          "tool_call": {
            "call_id": "call-1",
            "name": "create_github_issue",
            "arguments": {},
            "tool_grant": "require_approval"
          }
        }
        """

        XCTAssertThrowsError(
            try JSONDecoder().decode(
                AgentGatewayApprovalRequest.self,
                from: Data(missingCallID.utf8)
            ).validated()
        )
        XCTAssertThrowsError(
            try JSONDecoder().decode(
                AgentGatewayApprovalRequest.self,
                from: Data(malformedGrant.utf8)
            ).validated()
        )
    }

    func testCentrifugoConnectionTokenCarriesMemberAndWorkspaceClaims() async throws {
        let workspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let memberID = UUID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let jwt = await JWTService(config: testServerConfig(centConnectionTokenTTL: 120))

        let issued = try await jwt.signCentrifugoConnection(
            memberID: memberID,
            workspaceID: workspaceID,
            credentialTokenID: UUID(uuidString: "00000000-0000-7000-8000-000000000901")!
        )
        let payload = try await jwt.verifyCentrifugoConnection(issued.token)
        let info = try JSONDecoder().decode(RealtimeTokenInfo.self, from: Data(payload.info.utf8))

        XCTAssertEqual(issued.ttlSeconds, 120)
        XCTAssertEqual(payload.sub.value, memberID.uuidString)
        XCTAssertEqual(payload.ws, workspaceID.uuidString)
        XCTAssertEqual(info.schema, "momo.realtime.connection.v0")
        XCTAssertEqual(info.workspaceId, workspaceID.uuidString)
        XCTAssertEqual(info.memberId, memberID.uuidString)
        XCTAssertEqual(payload.meta.schema, "momo.realtime.credential.v1")
        XCTAssertEqual(payload.meta.tokenId, "00000000-0000-7000-8000-000000000901")
    }

    func testExpiredAppAccessTokenCannotBackRealtimeTokenFlow() async throws {
        let workspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let memberID = UUID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let jwt = await JWTService(config: testServerConfig(accessTokenTTL: -60))
        let expired = try await jwt.signAccess(
            memberID: memberID,
            workspaceID: workspaceID,
            scopes: ["messages:read"]
        )

        do {
            _ = try await jwt.verify(expired.token)
            XCTFail("expired app access token should be rejected before realtime token issue")
        } catch {
            // Expected: JWTKit rejects the expired access token.
        }
    }

    func testRealtimeTokenResponseEncodesClientContract() throws {
        let response = RealtimeTokenResponse(
            token: "jwt",
            tokenType: "centrifugo.connection.jwt",
            expiresAtMs: 1_782_463_260_000,
            ttlSeconds: 300,
            workspaceId: "00000000-0000-7000-8000-000000000001",
            memberId: "00000000-0000-7000-8000-000000000101"
        )

        let object = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(response)
        ) as? [String: Any]

        XCTAssertEqual(object?["token"] as? String, "jwt")
        XCTAssertEqual(object?["tokenType"] as? String, "centrifugo.connection.jwt")
        XCTAssertEqual(object?["expiresAtMs"] as? Int, 1_782_463_260_000)
        XCTAssertEqual(object?["ttlSeconds"] as? Int, 300)
        XCTAssertEqual(object?["workspaceId"] as? String, "00000000-0000-7000-8000-000000000001")
        XCTAssertEqual(object?["memberId"] as? String, "00000000-0000-7000-8000-000000000101")
    }

    func testAuthSessionResponseAdvertisesRealtimeWebSocketURL() throws {
        let response = LoginResponse(
            accessToken: "access",
            refreshToken: "refresh",
            member: MemberDTO(
                id: "00000000-0000-7000-8000-000000000101",
                workspaceId: "00000000-0000-7000-8000-000000000001",
                kind: "human",
                displayName: "성재",
                handle: "seongjae"
            ),
            realtimeWebSocketUrl: "wss://rt.momo.test/connection/websocket"
        )

        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(response)) as? [String: Any]
        )
        XCTAssertEqual(
            object["realtimeWebSocketUrl"] as? String,
            "wss://rt.momo.test/connection/websocket"
        )
    }

    func testRealtimeWebSocketURLConfigUsesAdvertisedValueAndLocalFallback() {
        XCTAssertEqual(
            Config.realtimeWebSocketURL(environment: [
                "MOMO_CENTRIFUGO_WS_URL": "wss://rt.momo.test/connection/websocket",
                "CENT_PORT": "29999",
            ]),
            "wss://rt.momo.test/connection/websocket"
        )
        XCTAssertEqual(
            Config.realtimeWebSocketURL(environment: ["CENT_PORT": "28100"]),
            "ws://127.0.0.1:28100/connection/websocket"
        )
    }

    func testRosterKindFilterValidation() throws {
        XCTAssertNil(try RosterRoutes.validatedKindFilter(nil))
        XCTAssertNil(try RosterRoutes.validatedKindFilter("   "))
        XCTAssertEqual(try RosterRoutes.validatedKindFilter(" HUMAN "), "human")
        XCTAssertEqual(try RosterRoutes.validatedKindFilter("agent"), "agent")
        XCTAssertThrowsError(try RosterRoutes.validatedKindFilter("bot"))
        XCTAssertThrowsError(try RosterRoutes.validatedKindFilter("platform"))
    }

    func testRosterLimitIsBoundedForV0() {
        XCTAssertEqual(RosterRoutes.validatedLimit(nil), 200)
        XCTAssertEqual(RosterRoutes.validatedLimit("0"), 1)
        XCTAssertEqual(RosterRoutes.validatedLimit("50"), 50)
        XCTAssertEqual(RosterRoutes.validatedLimit("1000"), 500)
        XCTAssertEqual(RosterRoutes.validatedLimit("not-a-number"), 200)
    }

    func testRosterMemberDTODecodesHumanAndAgentShapes() throws {
        let data = Data("""
        [
          {
            "id": "00000000-0000-7000-8000-000000000101",
            "workspaceId": "00000000-0000-7000-8000-000000000001",
            "kind": "human",
            "status": "active",
            "displayName": "Demo Human",
            "handle": "demo",
            "avatarUrl": null,
            "role": "owner",
            "channelCount": 2,
            "email": "demo@momo.local",
            "timeZone": "Asia/Seoul",
            "agentModel": null,
            "ownerHumanId": null,
            "maxConcurrentRuns": null,
            "maxRunSteps": null,
            "createdAtMs": 1782463260000,
            "updatedAtMs": 1782463260000
          },
          {
            "id": "00000000-0000-7000-8000-000000000102",
            "workspaceId": "00000000-0000-7000-8000-000000000001",
            "kind": "agent",
            "status": "active",
            "displayName": "Kim Intern",
            "handle": "kim-intern",
            "avatarUrl": null,
            "role": "member",
            "channelCount": 2,
            "email": null,
            "timeZone": null,
            "agentModel": "hermes-agent",
            "ownerHumanId": "00000000-0000-7000-8000-000000000101",
            "maxConcurrentRuns": 1,
            "maxRunSteps": 12,
            "capabilities": ["code", "terminal"],
            "createdAtMs": 1782463260000,
            "updatedAtMs": 1782463260000
          }
        ]
        """.utf8)

        let members = try JSONDecoder().decode([RosterMemberDTO].self, from: data)

        XCTAssertEqual(members.map(\.kind), ["human", "agent"])
        XCTAssertEqual(members[0].email, "demo@momo.local")
        XCTAssertNil(members[0].agentModel)
        XCTAssertEqual(members[1].agentModel, "hermes-agent")
        XCTAssertEqual(members[1].capabilities, ["code", "terminal"])
        XCTAssertNil(members[1].email)
        XCTAssertEqual(members[0].capabilities, [], "legacy human roster rows default safely")
    }

    func testChannelLimitIsBoundedForV0() {
        XCTAssertEqual(ChannelRoutes.validatedLimit(nil), 200)
        XCTAssertEqual(ChannelRoutes.validatedLimit("0"), 1)
        XCTAssertEqual(ChannelRoutes.validatedLimit("50"), 50)
        XCTAssertEqual(ChannelRoutes.validatedLimit("1000"), 500)
        XCTAssertEqual(ChannelRoutes.validatedLimit("not-a-number"), 200)
    }

    func testWorkspaceChannelsResponseDecodesMacOSRESTShape() throws {
        let data = Data("""
        {
          "channels": [
            {
              "id": "00000000-0000-7000-8000-000000000201",
              "workspaceId": "00000000-0000-7000-8000-000000000001",
              "kind": "public",
              "name": "general",
              "topic": "팀 일반 채널",
              "dmKey": null,
              "createdBy": "00000000-0000-7000-8000-000000000101",
              "archivedAtMs": null,
              "muted": true
            },
            {
              "id": "00000000-0000-7000-8000-000000000202",
              "workspaceId": "00000000-0000-7000-8000-000000000001",
              "kind": "public",
              "name": "agent-lab",
              "topic": "에이전트 실험실",
              "dmKey": null,
              "createdBy": "00000000-0000-7000-8000-000000000101",
              "archivedAtMs": null,
              "muted": false
            }
          ]
        }
        """.utf8)

        let response = try JSONDecoder().decode(WorkspaceChannelsResponse.self, from: data)

        XCTAssertEqual(response.channels.map(\.name), ["general", "agent-lab"])
        XCTAssertEqual(response.channels.map(\.kind), ["public", "public"])
        XCTAssertEqual(response.channels.map(\.muted), [true, false])
        XCTAssertEqual(response.channels.first?.createdBy, "00000000-0000-7000-8000-000000000101")
        XCTAssertNil(response.channels.first?.archivedAtMs)
    }

    func testDirectMessageParticipantKeyIsOrderIndependentAndRejectsSelf() throws {
        let first = UUID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let second = UUID(uuidString: "00000000-0000-7000-8000-000000000103")!

        XCTAssertEqual(
            DMRoutes.canonicalParticipantIDs(first, second),
            DMRoutes.canonicalParticipantIDs(second, first)
        )
        XCTAssertNoThrow(try DMRoutes.validateTargetMember(actorID: first, targetID: second))
        XCTAssertThrowsError(try DMRoutes.validateTargetMember(actorID: first, targetID: first)) { error in
            XCTAssertEqual((error as? HTTPError)?.status, .badRequest)
        }
    }

    func testDirectMessageResponseCarriesCanonicalParticipantsAndCreatedState() throws {
        let data = Data("""
        {
          "channel": {
            "id": "00000000-0000-7000-8000-000000000299",
            "workspaceId": "00000000-0000-7000-8000-000000000001",
            "kind": "dm",
            "name": null,
            "topic": null,
            "dmKey": "sha256-pair",
            "memberIds": [
              "00000000-0000-7000-8000-000000000101",
              "00000000-0000-7000-8000-000000000103"
            ],
            "createdBy": "00000000-0000-7000-8000-000000000101",
            "archivedAtMs": null,
            "muted": false
          },
          "created": false
        }
        """.utf8)

        let response = try JSONDecoder().decode(OpenDirectMessageResponse.self, from: data)

        XCTAssertEqual(response.channel.kind, "dm")
        XCTAssertEqual(response.channel.memberIds?.count, 2)
        XCTAssertFalse(response.channel.muted)
        XCTAssertFalse(response.created, "A repeated POST returns the existing DM")
    }

    func testDirectMessageRoutesKeepRLSPermissionAndSingleTransactionContracts() throws {
        let testFile = URL(fileURLWithPath: #filePath)
        let serverRoot = testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let routeSource = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Routes/DMRoutes.swift"
            ),
            encoding: .utf8
        )

        XCTAssertTrue(routeSource.contains("withTenantConnection"))
        XCTAssertTrue(routeSource.contains("withTenantTransaction"))
        XCTAssertTrue(routeSource.contains("WorkspaceAuthorization.activeRole"))
        XCTAssertTrue(routeSource.contains("m.workspace_id ="))
        XCTAssertTrue(routeSource.contains("m.status = 'active'"))
        XCTAssertTrue(routeSource.contains("return .targetNotFound"))
        XCTAssertTrue(routeSource.contains("case .targetNotFound:"))
        XCTAssertTrue(routeSource.contains("pg_advisory_xact_lock"))
        XCTAssertTrue(routeSource.contains("ON CONFLICT (workspace_id, dm_key) WHERE kind = 'dm'"))
        XCTAssertTrue(routeSource.contains("ON CONFLICT (channel_id, member_id)"))
        XCTAssertTrue(routeSource.contains("INSERT INTO channel_seq"))
        XCTAssertTrue(routeSource.contains("SET archived_at = NULL"))
        XCTAssertTrue(routeSource.contains("digest("))
        XCTAssertFalse(routeSource.contains("withPlatformReadConnection"))
        XCTAssertFalse(routeSource.contains("BYPASSRLS"))
    }

    func testInboundMCPToolSurfaceMatchesMOMO163() {
        let names = InboundMCPToolRegistry.tools.map(\.name)
        XCTAssertEqual(
            names,
            [.searchMessages, .fetchThread, .postMessage, .createToolCall]
        )
    }

    func testInboundMCPPoliciesRequireRLSAndExpectedScopes() {
        let policies = Dictionary(
            uniqueKeysWithValues: InboundMCPToolRegistry.tools.map { ($0.name, $0.policy) }
        )

        XCTAssertEqual(policies[.searchMessages]?.requiredScopes, [.read])
        XCTAssertEqual(policies[.fetchThread]?.requiredScopes, [.read])
        XCTAssertEqual(policies[.postMessage]?.requiredScopes, [.post])
        XCTAssertEqual(policies[.createToolCall]?.requiredScopes, [.toolPropose])

        for policy in policies.values {
            XCTAssertTrue(policy.requiresRLS)
            XCTAssertTrue(policy.requiresChannelMembership)
            XCTAssertFalse(policy.executesProviderTool)
            XCTAssertFalse(policy.auditAction.isEmpty)
        }

        XCTAssertEqual(
            policies[.postMessage]?.canonicalWritePath,
            "channel_seq_bump_message_insert_outbox_insert"
        )
        XCTAssertEqual(
            policies[.createToolCall]?.writes,
            ["message:tool_call", "approval", "message:approval_request", "outbox", "audit_log"]
        )
    }

    func testInboundMCPDiscoveryIsCodable() throws {
        let discovery = InboundMCPToolRegistry.discoveryResponse()
        let data = try JSONEncoder().encode(discovery)
        let decoded = try JSONDecoder().decode(InboundMCPDiscoveryResponse.self, from: data)

        XCTAssertEqual(decoded.schema, "momo.inbound_mcp.discovery_snapshot.v0")
        XCTAssertEqual(decoded.server.protocolVersion, "2025-06-18")
        XCTAssertTrue(decoded.server.capabilities.tools.listChanged)
        XCTAssertTrue(decoded.runtimeStatus.contains("runtime-unverified"))
    }

    func testSearchMessagesRequiresBoundedChannelIDsInDescriptor() throws {
        let descriptor = InboundMCPToolRegistry.descriptor(named: .searchMessages)
        let schema = try XCTUnwrap(descriptor.inputSchema.objectValue)
        let required = try XCTUnwrap(schema["required"]?.arrayValue)
            .compactMap(\.stringValue)
        let properties = try XCTUnwrap(schema["properties"]?.objectValue)
        let channelIDs = try XCTUnwrap(properties["channel_ids"]?.objectValue)

        XCTAssertTrue(required.contains("channel_ids"))
        XCTAssertEqual(channelIDs["maxItems"], .int(InboundMCPToolRegistry.searchMessagesMaxChannelIDs))
    }

    func testSearchMessagesChannelIDsFailClosedBeforeDBPreflight() throws {
        XCTAssertThrowsError(try InboundMCPRoutes.channelIDs(
            for: .searchMessages,
            arguments: ["workspace_id": .string("00000000-0000-7000-8000-000000000001")]
        ))

        XCTAssertThrowsError(try InboundMCPRoutes.channelIDs(
            for: .searchMessages,
            arguments: [
                "channel_ids": .array([])
            ]
        ))

        let tooMany = (0...InboundMCPToolRegistry.searchMessagesMaxChannelIDs)
            .map { JSONValue.string(String(format: "00000000-0000-7000-8000-%012d", $0)) }
        XCTAssertThrowsError(try InboundMCPRoutes.channelIDs(
            for: .searchMessages,
            arguments: [
                "channel_ids": .array(tooMany)
            ]
        ))
    }

    func testApprovalDecisionRequestDecodesMomoCoreWireShape() throws {
        let data = Data("""
        {
          "approval_id": "00000000-0000-7000-8000-000000000901",
          "approve": true,
          "reason": "  safe to run  ",
          "client_decision_id": "00000000-0000-7000-8000-000000167001"
        }
        """.utf8)

        let dto = try JSONDecoder().decode(ApprovalDecisionRequestDTO.self, from: data)

        XCTAssertEqual(dto.approvalId.uuidString.lowercased(), "00000000-0000-7000-8000-000000000901")
        XCTAssertTrue(dto.approve)
        XCTAssertEqual(dto.clientDecisionId.uuidString.lowercased(), "00000000-0000-7000-8000-000000167001")
        XCTAssertEqual(ApprovalDecisionRoutes.status(approve: dto.approve), "approved")
        XCTAssertEqual(ApprovalDecisionRoutes.normalizedReason(dto.reason), "safe to run")
    }

    func testApprovalDecisionReceiptEncodesSnakeCaseContract() throws {
        let receipt = ApprovalDecisionReceiptDTO(
            approvalId: "00000000-0000-7000-8000-000000000901",
            status: "rejected",
            decidedBy: "00000000-0000-7000-8000-000000000101",
            decidedAtMs: 1_782_463_260_000,
            decisionReason: "Do not create external state."
        )

        let object = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(receipt)
        ) as? [String: Any]

        XCTAssertEqual(object?["approval_id"] as? String, receipt.approvalId)
        XCTAssertEqual(object?["status"] as? String, "rejected")
        XCTAssertEqual(object?["decided_by"] as? String, receipt.decidedBy)
        XCTAssertEqual(object?["decided_at_ms"] as? Int, Int(receipt.decidedAtMs!))
        XCTAssertNil(object?["approvalId"])
    }

    func testCentrifugoSubscribeParserDistinguishesChannelAndAgentNamespaces() throws {
        let workspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let channelID = UUID(uuidString: "00000000-0000-7000-8000-000000000202")!
        let agentMemberID = UUID(uuidString: "00000000-0000-7000-8000-000000000102")!

        XCTAssertEqual(
            CentrifugoRoutes.parseChannel("ch:ws\(workspaceID.uuidString).\(channelID.uuidString)"),
            .channel(workspace: workspaceID, channel: channelID)
        )
        XCTAssertEqual(
            CentrifugoRoutes.parseChannel("agent:ws\(workspaceID.uuidString).\(channelID.uuidString).\(agentMemberID.uuidString)"),
            .agent(workspace: workspaceID, channel: channelID, agentMember: agentMemberID)
        )
        XCTAssertEqual(
            CentrifugoRoutes.parseChannel("agentwork:ws\(workspaceID.uuidString).\(agentMemberID.uuidString)"),
            .agentWork(workspace: workspaceID, agentMember: agentMemberID)
        )
        XCTAssertNil(CentrifugoRoutes.parseChannel("user:\(agentMemberID.uuidString)"))
        XCTAssertNil(CentrifugoRoutes.parseChannel("agent:ws\(workspaceID.uuidString).\(agentMemberID.uuidString)"))
        XCTAssertNil(CentrifugoRoutes.parseChannel("agent:ws\(workspaceID.uuidString).not-a-uuid"))
    }

    func testPrivateAgentWorkStreamSubscriptionIsSelfOnly() {
        let agentA = UUID()
        let agentB = UUID()

        XCTAssertTrue(
            CentrifugoRoutes.isSelfAgentSubscription(
                userMemberID: agentA,
                agentMemberID: agentA
            )
        )
        XCTAssertFalse(
            CentrifugoRoutes.isSelfAgentSubscription(
                userMemberID: agentA,
                agentMemberID: agentB
            )
        )
    }

    func testApprovalDecisionRouteRejectsMismatchedBodyApprovalID() throws {
        let pathID = UUID(uuidString: "00000000-0000-7000-8000-000000000901")!
        let bodyID = UUID(uuidString: "00000000-0000-7000-8000-000000000902")!

        XCTAssertThrowsError(
            try ApprovalDecisionRoutes.validateBodyApprovalID(bodyID, pathApprovalID: pathID)
        )
        XCTAssertNoThrow(
            try ApprovalDecisionRoutes.validateBodyApprovalID(pathID, pathApprovalID: pathID)
        )
    }

    func testWorkControlApprovalDoesNotResumeAgentRun() throws {
        let controlID = UUID(uuidString: "00000000-0000-7000-8000-000000000941")!
        let payload: JSONValue = .object([
            "source": .string("work_control"),
            "work_control_id": .string(controlID.uuidString),
        ])

        let parsedControlID = try WorkControlRoutes.workControlID(from: payload)
        XCTAssertEqual(parsedControlID, controlID)
        XCTAssertFalse(
            ApprovalDecisionRoutes.shouldApplyGenericAgentDecisionFlow(
                workControlID: parsedControlID
            )
        )
        XCTAssertTrue(
            ApprovalDecisionRoutes.shouldApplyGenericAgentDecisionFlow(
                workControlID: nil
            )
        )
    }

    func testApprovalProjectionDTOEncodesPendingInboxContract() throws {
        let projection = ApprovalProjectionPageDTO(approvals: [
            ApprovalProjectionDTO(
                id: "00000000-0000-7000-8000-000000000901",
                workspaceId: "00000000-0000-7000-8000-000000000001",
                runId: "00000000-0000-7000-8000-000000000801",
                channelId: "00000000-0000-7000-8000-000000000201",
                requestMessageId: "00000000-0000-7000-8000-000000000701",
                requestedBy: "00000000-0000-7000-8000-000000000102",
                onBehalfOf: "00000000-0000-7000-8000-000000000101",
                actionType: "github.issue.create",
                payload: .object(["title": .string("Ship gated write")]),
                status: "pending",
                estimatedMicroUSD: 820_000,
                isReversible: true,
                decidedBy: nil,
                decidedAtMs: nil,
                decisionReason: nil,
                expiresAtMs: 1_782_463_260_000
            )
        ])

        let object = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(projection)
        ) as? [String: Any]
        let approvals = try XCTUnwrap(object?["approvals"] as? [[String: Any]])
        let first = try XCTUnwrap(approvals.first)

        XCTAssertEqual(first["approval_id"] as? String, nil)
        XCTAssertEqual(first["id"] as? String, "00000000-0000-7000-8000-000000000901")
        XCTAssertEqual(first["workspace_id"] as? String, "00000000-0000-7000-8000-000000000001")
        XCTAssertEqual(first["action_type"] as? String, "github.issue.create")
        XCTAssertEqual(first["status"] as? String, "pending")
        XCTAssertEqual(first["estimated_micro_usd"] as? Int, 820_000)
        XCTAssertEqual(first["is_reversible"] as? Bool, true)
        XCTAssertNil(first["workspaceId"])
    }

    func testApprovalProjectionStatusAndLimitValidation() throws {
        XCTAssertEqual(try ApprovalDecisionRoutes.validatedStatus(nil), "pending")
        XCTAssertEqual(try ApprovalDecisionRoutes.validatedStatus(" pending "), "pending")
        XCTAssertEqual(try ApprovalDecisionRoutes.validatedStatus("rejected"), "rejected")
        XCTAssertThrowsError(try ApprovalDecisionRoutes.validatedStatus("all"))

        XCTAssertEqual(ApprovalDecisionRoutes.validatedLimit(nil), 100)
        XCTAssertEqual(ApprovalDecisionRoutes.validatedLimit("0"), 1)
        XCTAssertEqual(ApprovalDecisionRoutes.validatedLimit("501"), 500)
    }

    func testMessageBroadcastPayloadUsesRealtimeSnakeCaseContract() throws {
        let workspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let channelID = UUID(uuidString: "00000000-0000-7000-8000-000000000010")!
        let messageID = UUID(uuidString: "00000000-0000-7000-8000-000000000179")!
        let authorID = UUID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let rootID = UUID(uuidString: "00000000-0000-7000-8000-000000000178")!
        let centChannel = "ch:ws\(workspaceID.uuidString).\(channelID.uuidString)"

        let raw = MessageRoutes.broadcastPayload(
            centChannel: centChannel,
            messageID: messageID,
            channelID: channelID,
            seq: 43,
            type: "text",
            body: "Realtime contract sample.",
            authorMemberID: authorID,
            hlcTs: 1_782_463_260_000,
            hlcCount: 0,
            rootID: rootID,
            props: [
                "mention_member_ids": [authorID.uuidString],
                "reply_to_id": rootID.uuidString,
                "approval_status": "pending",
                "approval_id": messageID.uuidString,
            ]
        )

        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any]
        )
        XCTAssertEqual(object["channel"] as? String, centChannel)
        XCTAssertEqual(object["version"] as? Int, 43)
        XCTAssertEqual(object["idempotency_key"] as? String, "\(centChannel):43")

        let data = try XCTUnwrap(object["data"] as? [String: Any])
        XCTAssertEqual(data["type"] as? String, "message.new")
        XCTAssertEqual(data["seq"] as? Int, 43)

        let payload = try XCTUnwrap(data["payload"] as? [String: Any])
        XCTAssertEqual(payload["channel_id"] as? String, channelID.uuidString)
        XCTAssertEqual(payload["author_member_id"] as? String, authorID.uuidString)
        XCTAssertEqual(payload["hlc_ts"] as? Int, 1_782_463_260_000)
        XCTAssertEqual(payload["hlc_count"] as? Int, 0)
        XCTAssertEqual(payload["root_id"] as? String, rootID.uuidString)
        let props = try XCTUnwrap(payload["props"] as? [String: Any])
        XCTAssertEqual(props["mention_member_ids"] as? [String], [authorID.uuidString])
        XCTAssertEqual(props["reply_to_id"] as? String, rootID.uuidString)
        XCTAssertEqual(props["approval_status"] as? String, "pending")
        XCTAssertEqual(props["approval_id"] as? String, messageID.uuidString)
        XCTAssertNil(payload["channelId"])
        XCTAssertNil(payload["authorMemberId"])
        XCTAssertNil(payload["hlcTs"])
        XCTAssertNil(payload["hlcCount"])
        XCTAssertNil(payload["rootId"])
        XCTAssertNil(payload["attachments"])

        let attachmentID = UUID(uuidString: "00000000-0000-7000-8000-000000000180")!
        let withAttachment = MessageRoutes.broadcastPayload(
            centChannel: centChannel,
            messageID: messageID,
            channelID: channelID,
            seq: 43,
            type: "text",
            body: "Realtime contract sample.",
            authorMemberID: authorID,
            hlcTs: 1_782_463_260_000,
            hlcCount: 0,
            rootID: rootID,
            attachments: [MessageAttachmentDTO(
                id: attachmentID.uuidString,
                name: "evidence.txt",
                mime: "text/plain",
                sizeBytes: 19
            )]
        )
        let attachmentObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(withAttachment.utf8)) as? [String: Any]
        )
        let attachmentPayload = try XCTUnwrap(
            (attachmentObject["data"] as? [String: Any])?["payload"] as? [String: Any]
        )
        let attachments = try XCTUnwrap(attachmentPayload["attachments"] as? [[String: Any]])
        XCTAssertEqual(attachments.count, 1)
        XCTAssertEqual(attachments[0]["id"] as? String, attachmentID.uuidString)
        XCTAssertEqual(attachments[0]["name"] as? String, "evidence.txt")
        XCTAssertEqual(attachments[0]["mime"] as? String, "text/plain")
        XCTAssertEqual(attachments[0]["sizeBytes"] as? Int, 19)
        XCTAssertNil(attachments[0]["uploadUrl"])
    }

    func testThreadRollupProjectionAndRealtimePayloadUseAdditiveSnakeCaseContract() throws {
        let workspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let channelID = UUID(uuidString: "00000000-0000-7000-8000-000000000010")!
        let rootID = UUID(uuidString: "00000000-0000-7000-8000-000000000178")!
        let authorID = UUID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let rollup = try XCTUnwrap(MessageRoutes.threadRollup(
            replyCount: 3,
            lastReplySeq: 43,
            lastReplyAt: Date(timeIntervalSince1970: 1_782_463_260.125)
        ))
        XCTAssertEqual(rollup.replyCount, 3)
        XCTAssertEqual(rollup.lastReplySeq, 43)
        XCTAssertEqual(rollup.lastReplyAt, 1_782_463_260_125)
        XCTAssertNil(MessageRoutes.threadRollup(
            replyCount: 0,
            lastReplySeq: nil,
            lastReplyAt: nil
        ))

        let message = MessageDTO(
            id: rootID.uuidString,
            channelId: channelID.uuidString,
            rootId: nil,
            seq: 40,
            hlcTs: 1_782_463_200_000,
            hlcCount: 0,
            authorMemberId: authorID.uuidString,
            type: "text",
            body: "root",
            props: nil,
            runId: nil,
            clientMsgId: nil,
            createdAtMs: 1_782_463_200_000,
            state: nil,
            editedAtMs: nil,
            deletedAtMs: nil,
            attachments: nil,
            thread: rollup
        )
        let encoded = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(message)) as? [String: Any]
        )
        let thread = try XCTUnwrap(encoded["thread"] as? [String: Any])
        XCTAssertEqual(thread["reply_count"] as? Int, 3)
        XCTAssertEqual(thread["last_reply_seq"] as? Int, 43)
        XCTAssertEqual(thread["last_reply_at"] as? Int64, 1_782_463_260_125)
        XCTAssertNil(thread["replyCount"])
        XCTAssertNil(encoded["attachments"])

        let raw = MessageRoutes.threadUpdatedPayload(
            workspaceID: workspaceID,
            channelID: channelID,
            rootID: rootID,
            rollup: rollup
        )
        let outbox = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any]
        )
        XCTAssertNil(
            outbox["version"],
            "thread.updated reuses the reply seq; a Centrifugo version <= the reply's message.new would be silently dropped"
        )
        let data = try XCTUnwrap(outbox["data"] as? [String: Any])
        XCTAssertEqual(data["type"] as? String, "thread.updated")
        XCTAssertEqual(data["seq"] as? Int, 43)
        let payload = try XCTUnwrap(data["payload"] as? [String: Any])
        XCTAssertEqual(payload["channel_id"] as? String, channelID.uuidString)
        XCTAssertEqual(payload["root_id"] as? String, rootID.uuidString)
        XCTAssertEqual(payload["reply_count"] as? Int, 3)
        XCTAssertEqual(payload["last_reply_seq"] as? Int, 43)
        XCTAssertEqual(payload["last_reply_at"] as? Int64, 1_782_463_260_125)
    }

    func testInteractionEnvelopesOmitCentrifugoVersion() throws {
        let workspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let channelID = UUID(uuidString: "00000000-0000-7000-8000-000000000201")!
        let channel = "ch:ws\(workspaceID.uuidString).\(channelID.uuidString)"
        let interactionTypes = [
            "message.edited",
            "message.deleted",
            "reaction.added",
            "reaction.removed",
        ]

        for eventType in interactionTypes {
            let raw = MessageRoutes.encodeInteractionPayload(
                workspaceID: workspaceID,
                channelID: channelID,
                eventType: eventType,
                timestampMs: 1_782_463_260_125,
                seq: 43,
                payload: .object(["message_id": .string(UUID().uuidString)])
            )
            let outbox = try XCTUnwrap(
                JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any]
            )
            XCTAssertNil(
                outbox["version"],
                "\(eventType) reuses its target message seq; a Centrifugo version <= message.new would be silently dropped"
            )
            XCTAssertEqual(outbox["channel"] as? String, channel)
            XCTAssertNotNil(outbox["idempotency_key"] as? String)
            let data = try XCTUnwrap(outbox["data"] as? [String: Any])
            XCTAssertEqual(data["type"] as? String, eventType)
            XCTAssertEqual(data["seq"] as? Int, 43)
        }
    }

    // MOMO-656 / #870. A daemon that restarts inside the offline grace window
    // keeps its heartbeat fresh, so the sweep alone can never notice its lost
    // PTYs. The host reports them; the sweep still owns every transition.
    func testWorkHostRestartReconciliationReusesTheOrphanSweepWithoutNewUX() throws {
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let serverRoot = repoRoot.appendingPathComponent("server")

        let migration = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Migrations/056_work_session_host_reconciliation.sql"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(migration.contains("ADD COLUMN host_lost_at timestamptz"))
        XCTAssertTrue(migration.contains("work_session_host_lost_idx"))
        // The marker must never become a lifecycle state or an end_reason the
        // clients would have to render, so the status/end_reason constraints
        // are left exactly as migration 047 defined them.
        XCTAssertFalse(migration.contains("ADD CONSTRAINT"))
        XCTAssertFalse(migration.contains("DROP CONSTRAINT"))

        let hostRoutes = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Routes/WorkHostRoutes.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(hostRoutes.contains("work-hosts/:host/live-sessions"))
        XCTAssertTrue(hostRoutes.contains("work-hosts/:host/reconcile"))
        XCTAssertTrue(hostRoutes.contains("requireSelfSignedHost"))
        XCTAssertTrue(hostRoutes.contains(
            "SET host_lost_at = COALESCE(host_lost_at, clock_timestamp())"
        ))
        XCTAssertTrue(hostRoutes.contains("AND status IN ('running', 'idle')"))
        XCTAssertTrue(hostRoutes.contains("'momo.work_session.host_lost.v1'::text"))
        // The route stamps eligibility only. Any status write here would be a
        // second orphan implementation racing the sweep.
        XCTAssertFalse(hostRoutes.contains("SET status = 'orphaned'"))
        XCTAssertFalse(hostRoutes.contains("resume_offer"))

        let authenticator = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Auth/WorkHostAuthenticator.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(authenticator.contains("\"live-sessions\""))
        XCTAssertTrue(authenticator.contains("\"reconcile\""))
        let reconcileWorkspaceID = UUID().uuidString.lowercased()
        let reconcileHostID = UUID().uuidString.lowercased()
        let livePath =
            "/v1/workspaces/\(reconcileWorkspaceID)/work-hosts/\(reconcileHostID)/live-sessions"
        let reconcilePath =
            "/v1/workspaces/\(reconcileWorkspaceID)/work-hosts/\(reconcileHostID)/reconcile"
        XCTAssertTrue(WorkHostAuthenticator.isAllowed(method: "GET", path: livePath))
        XCTAssertTrue(WorkHostAuthenticator.isAllowed(method: "POST", path: reconcilePath))
        // Method confusion must not open the other verb on either path.
        XCTAssertFalse(WorkHostAuthenticator.isAllowed(method: "POST", path: livePath))
        XCTAssertFalse(WorkHostAuthenticator.isAllowed(method: "GET", path: reconcilePath))
        XCTAssertEqual(
            WorkHostAuthenticator.scopedHostID(fromPath: reconcilePath)?
                .uuidString.lowercased(),
            reconcileHostID
        )

        let sweep = try String(
            contentsOf: repoRoot.appendingPathComponent(
                "workers/NotifierWorker/Sources/NotifierWorker/TierFallbackSweep.swift"
            ),
            encoding: .utf8
        )
        // Host loss now has two equally authoritative signals.
        XCTAssertTrue(sweep.contains("ws.host_lost_at IS NOT NULL AS host_reported_lost"))
        XCTAssertTrue(sweep.contains("work_session.host_lost_at IS NOT NULL"))
        // ...and is still processed before ADR-0139 idle timeout.
        XCTAssertTrue(sweep.contains("AND ws.host_lost_at IS NULL"))
        // The marker is consumed by the transition, so a returning host that
        // starts fresh sessions is not swept again.
        XCTAssertTrue(sweep.contains("host_lost_at = NULL"))
        XCTAssertTrue(sweep.contains("\"orphan_source\": session.orphanSource"))
        XCTAssertTrue(sweep.contains("host_reconciliation"))
    }

    func testWorkSessionMigrationAndRouteKeepLedgerBoundary() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let migration = try String(
            contentsOf: serverRoot.appendingPathComponent("Migrations/019_work_session.sql"),
            encoding: .utf8
        )
        XCTAssertTrue(migration.contains("CREATE TABLE work_session"))
        XCTAssertTrue(migration.contains("id               uuid PRIMARY KEY DEFAULT uuidv7()"))
        XCTAssertTrue(migration.contains("host_id          uuid NOT NULL"))
        XCTAssertTrue(migration.contains("root_message_id  uuid NOT NULL UNIQUE REFERENCES message(id)"))
        XCTAssertTrue(migration.contains("tool IN ('claude', 'codex', 'opencode', 'shell')"))
        XCTAssertTrue(migration.contains("length(btrim(label)) BETWEEN 1 AND 120"))
        XCTAssertTrue(migration.contains("status IN ('running', 'ended')"))
        XCTAssertTrue(migration.contains("FORCE ROW LEVEL SECURITY"))
        XCTAssertFalse(migration.contains("\n  cwd"), "cwd/path must stay host-local")

        let routes = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Routes/WorkSessionRoutes.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(routes.contains("WITH bumped AS"))
        XCTAssertTrue(routes.contains("'system'::message_type"))
        XCTAssertTrue(routes.contains("MessageRoutes.broadcastPayload"))
        XCTAssertTrue(routes.contains("work.session.started"))
        XCTAssertTrue(routes.contains("work.session.ended"))
        XCTAssertTrue(routes.contains("work.session.idle"))
        XCTAssertTrue(routes.contains("work.session.resumed-to-running"))
        XCTAssertTrue(routes.contains("FOR UPDATE OF ws"))
        XCTAssertTrue(routes.contains("only the session owner can end it"))
        XCTAssertTrue(routes.contains("controlId is reserved for work host dispatch"))
        XCTAssertTrue(routes.contains("requireDispatchedSpawnControl"))
        XCTAssertTrue(routes.contains("WorkPoolRoutes.acquireSlot"))
        XCTAssertTrue(routes.contains("wc.payload->>'tool'"))
        XCTAssertTrue(routes.contains("work host cannot end another host session"))
        XCTAssertTrue(routes.contains("JOIN membership ms"))
        XCTAssertFalse(routes.contains("BYPASSRLS"))

        let idleMigration = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Migrations/047_work_session_idle.sql"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(idleMigration.contains("status IN ('running', 'idle', 'orphaned', 'ended')"))
        XCTAssertTrue(idleMigration.contains("'idle_timeout'"))
        XCTAssertTrue(idleMigration.contains("ADD COLUMN idle_at timestamptz"))
        XCTAssertTrue(idleMigration.contains("status = 'idle'"))
        XCTAssertFalse(
            idleMigration.contains("status = 'running' AND exit_code IS NULL"),
            "exit_code is the last tool result and must survive idle-to-running"
        )
    }

    /// MOMO-671 / ADR-0143. These are the two invariants that would silently
    /// regress: implicit creation must stay in the ledger trigger (so no insert
    /// path can produce an unattached Run), and resume eligibility must stay
    /// channel membership rather than session ownership.
    func testWorkstreamMigrationAndResumeEligibility() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let migration = try String(
            contentsOf: serverRoot.appendingPathComponent("Migrations/055_workstream.sql"),
            encoding: .utf8
        )
        XCTAssertTrue(migration.contains("CREATE TABLE workstream"))
        XCTAssertTrue(
            migration.contains("status IN ('active', 'paused', 'done', 'cancelled')")
        )
        XCTAssertTrue(
            migration.contains("root_message_id      uuid NOT NULL UNIQUE REFERENCES message(id)")
        )
        XCTAssertTrue(migration.contains("ADD COLUMN workstream_id uuid"))
        XCTAssertTrue(
            migration.contains("REFERENCES workstream (workspace_id, id)"),
            "the Run FK must be composite so a Run cannot point at another tenant"
        )
        XCTAssertTrue(migration.contains("ALTER COLUMN workstream_id SET NOT NULL"))
        XCTAssertTrue(migration.contains("CREATE TRIGGER work_session_attach_workstream_trg"))
        XCTAssertTrue(migration.contains("BEFORE INSERT ON work_session"))
        XCTAssertTrue(migration.contains("ON CONFLICT (root_message_id)"))
        XCTAssertTrue(migration.contains("FORCE ROW LEVEL SECURITY"))
        XCTAssertFalse(
            migration.contains("pty_id"),
            "host-local binding must not leak into the goal layer"
        )

        let routes = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Routes/WorkSessionRoutes.swift"
            ),
            encoding: .utf8
        )
        XCTAssertFalse(
            routes.contains("only the session owner can resume it"),
            "ADR-0143 D2 replaced the resume owner guard with channel membership"
        )
        XCTAssertTrue(routes.contains("resumed_from_session_id, workstream_id"))
        XCTAssertTrue(routes.contains("only the session owner can end it"))

        let workstreamRoutes = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Routes/WorkstreamRoutes.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(workstreamRoutes.contains("JOIN membership ms"))
        XCTAssertTrue(workstreamRoutes.contains("workstream not found"))
        XCTAssertFalse(workstreamRoutes.contains("BYPASSRLS"))
        for leaked in ["pty_id", "attach_endpoint", "cwd"] {
            XCTAssertFalse(
                workstreamRoutes.contains(leaked),
                "\(leaked) must stay out of the workstream projection"
            )
        }
    }

    func testWorkstreamQueryFilterValidation() throws {
        XCTAssertNil(try WorkstreamRoutes.validatedStatus(nil))
        XCTAssertNil(try WorkstreamRoutes.validatedStatus(""))
        XCTAssertEqual(try WorkstreamRoutes.validatedStatus("active"), "active")
        XCTAssertEqual(try WorkstreamRoutes.validatedStatus("cancelled"), "cancelled")
        XCTAssertThrowsError(try WorkstreamRoutes.validatedStatus("Active"))
        XCTAssertThrowsError(try WorkstreamRoutes.validatedStatus("archived"))

        XCTAssertEqual(
            try WorkstreamRoutes.validatedLimit(nil),
            WorkstreamRoutes.defaultListLimit
        )
        XCTAssertEqual(try WorkstreamRoutes.validatedLimit("200"), 200)
        XCTAssertThrowsError(try WorkstreamRoutes.validatedLimit("0"))
        XCTAssertThrowsError(try WorkstreamRoutes.validatedLimit("201"))
        XCTAssertThrowsError(try WorkstreamRoutes.validatedLimit("many"))

        XCTAssertNil(try WorkstreamRoutes.optionalUUID(nil, label: "sessionId"))
        XCTAssertThrowsError(try WorkstreamRoutes.optionalUUID("nope", label: "sessionId"))
        let id = UUID(uuidString: "00000000-0000-7000-8000-000000000671")!
        XCTAssertEqual(
            try WorkstreamRoutes.optionalUUID(id.uuidString, label: "sessionId"),
            id
        )
    }

    func testWorkSessionValidationCardAndNoVersionLifecyclePayload() throws {
        XCTAssertEqual(try WorkSessionRoutes.validatedTool("codex"), "codex")
        XCTAssertEqual(try WorkSessionRoutes.validatedTool("bash"), "bash")
        XCTAssertThrowsError(try WorkSessionRoutes.validatedTool("/bin/bash"))
        XCTAssertEqual(try WorkSessionRoutes.validatedLabel("  ship it  "), "ship it")
        XCTAssertThrowsError(try WorkSessionRoutes.validatedLabel("   "))
        XCTAssertThrowsError(
            try WorkSessionRoutes.validatedLabel(String(repeating: "x", count: 121))
        )
        XCTAssertFalse(try WorkSessionRoutes.activeFilter(nil))
        XCTAssertFalse(try WorkSessionRoutes.activeFilter("0"))
        XCTAssertTrue(try WorkSessionRoutes.activeFilter("1"))
        XCTAssertThrowsError(try WorkSessionRoutes.activeFilter("true"))

        let sessionID = UUID(uuidString: "00000000-0000-7000-8000-000000000483")!
        let props = WorkSessionRoutes.cardProps(
            sessionID: sessionID,
            tool: "codex",
            label: "MOMO-483",
            status: "running"
        )
        XCTAssertEqual(props["kind"] as? String, "work_session")
        XCTAssertEqual(props["session_id"] as? String, sessionID.uuidString)
        XCTAssertEqual(props["tool"] as? String, "codex")
        XCTAssertEqual(props["label"] as? String, "MOMO-483")
        XCTAssertEqual(props["status"] as? String, "running")

        let session = WorkSessionDTO(
            id: sessionID.uuidString,
            workspaceId: "00000000-0000-7000-8000-000000000001",
            channelId: "00000000-0000-7000-8000-000000000201",
            memberId: "00000000-0000-7000-8000-000000000101",
            hostId: "00000000-0000-7000-8000-000000000901",
            rootMessageId: "00000000-0000-7000-8000-000000000701",
            tool: "codex",
            label: "MOMO-483",
            status: "ended",
            observation: .open,
            observerGrantCount: 0,
            remoteAttachAvailable: true,
            startedAtMs: 1_782_463_200_000,
            endedAtMs: 1_782_463_260_000,
            exitCode: 0,
            endReason: nil,
            resumedFromSessionId: nil
        )
        let sessionObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(session))
                as? [String: Any]
        )
        XCTAssertEqual(sessionObject["observation"] as? String, "open")
        XCTAssertEqual(sessionObject["observerGrantCount"] as? Int, 0)
        XCTAssertEqual(sessionObject["remoteAttachAvailable"] as? Bool, true)
        XCTAssertNil(sessionObject["attachEndpoint"])
        XCTAssertNil(sessionObject["capabilityToken"])
        for eventType in ["work.session.started", "work.session.ended"] {
            let raw = WorkSessionRoutes.lifecyclePayload(
                eventType: eventType,
                session: session,
                rootMessageSeq: 43
            )
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any]
            )
            XCTAssertNil(
                object["version"],
                "work session projections reuse the card seq claimed by message.new"
            )
            XCTAssertNotNil(object["idempotency_key"] as? String)
            let data = try XCTUnwrap(object["data"] as? [String: Any])
            XCTAssertEqual(data["type"] as? String, eventType)
            XCTAssertEqual(data["seq"] as? Int, 43)
            let payload = try XCTUnwrap(data["payload"] as? [String: Any])
            XCTAssertEqual(payload["session_id"] as? String, sessionID.uuidString)
            XCTAssertEqual(payload["channel_id"] as? String, session.channelId)
            XCTAssertEqual(payload["root_message_id"] as? String, session.rootMessageId)
            XCTAssertEqual(payload["member_id"] as? String, session.memberId)
            XCTAssertEqual(payload["host_id"] as? String, session.hostId)
            XCTAssertEqual(payload["tool"] as? String, "codex")
            XCTAssertEqual(payload["label"] as? String, "MOMO-483")
        }

        let idleSession = WorkSessionDTO(
            id: session.id,
            workspaceId: session.workspaceId,
            channelId: session.channelId,
            memberId: session.memberId,
            hostId: session.hostId,
            rootMessageId: session.rootMessageId,
            tool: session.tool,
            label: session.label,
            status: "idle",
            observation: session.observation,
            observerGrantCount: 0,
            remoteAttachAvailable: true,
            startedAtMs: session.startedAtMs,
            endedAtMs: nil,
            exitCode: 7,
            endReason: nil,
            resumedFromSessionId: nil
        )
        let idleRaw = WorkSessionRoutes.toolLifecyclePayload(
            eventType: "work.session.idle",
            session: idleSession,
            seq: 44,
            timestampMs: 1_782_463_261_000,
            idempotencyDiscriminator: "idle-message"
        )
        let idleObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(idleRaw.utf8)) as? [String: Any]
        )
        XCTAssertNil(idleObject["version"])
        let idleData = try XCTUnwrap(idleObject["data"] as? [String: Any])
        XCTAssertEqual(idleData["type"] as? String, "work.session.idle")
        XCTAssertEqual(idleData["seq"] as? Int, 44)
        let idlePayload = try XCTUnwrap(idleData["payload"] as? [String: Any])
        XCTAssertEqual(
            Set(idlePayload.keys),
            ["session_id", "channel_id", "root_message_id", "member_id",
             "host_id", "status", "idle_at", "exit_code"]
        )
        XCTAssertEqual(idlePayload["status"] as? String, "idle")
        XCTAssertEqual(idlePayload["exit_code"] as? Int, 7)
    }

    func testWorkSessionACPEventValidationAndNoVersionProjection() throws {
        XCTAssertEqual(WorkSessionRoutes.maximumACPEventsPerWindow, 240)
        XCTAssertEqual(WorkSessionRoutes.acpEventRateWindowSeconds, 60)
        XCTAssertEqual(WorkSessionRoutes.maximumACPEventBytes, 65_536)
        let sessionID = UUID(uuidString: "00000000-0000-7000-8000-000000000531")!
        let channelID = UUID(uuidString: "00000000-0000-7000-8000-000000000202")!
        let eventID = UUID(uuidString: "00000000-0000-7000-8000-000000000546")!
        let event = WorkSessionACPEvent(
            eventId: eventID,
            type: "agent.status",
            v: 1,
            ts: 1_784_678_400_000,
            payload: .object([
                "run_id": .string(sessionID.uuidString.lowercased()),
                "work_session_id": .string(sessionID.uuidString.lowercased()),
                "channel_id": .string(channelID.uuidString.lowercased()),
                "phase": .string("thinking"),
                "run_status": .string("running"),
                "detail": .string("Plan ready"),
                "has_plan": .bool(true),
                "plan": .array([.object(["content": .string("Implement relay")])]),
            ])
        )
        let validated = try WorkSessionRoutes.validatedACPEvent(event, sessionID: sessionID)
        XCTAssertEqual(validated.channelID, channelID)
        XCTAssertEqual(validated.body, "Plan ready")
        XCTAssertEqual(validated.props["kind"] as? String, "work_session_event")

        let raw = WorkSessionRoutes.acpEventPayload(
            channel: "ch:ws00000000-0000-7000-8000-000000000001.\(channelID.uuidString)",
            event: event,
            safePayload: validated.safePayload,
            messageID: UUID(),
            rootMessageID: UUID(),
            seq: 77
        )
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any]
        )
        XCTAssertNil(object["version"])
        let data = try XCTUnwrap(object["data"] as? [String: Any])
        XCTAssertEqual(data["type"] as? String, "agent.status")
        XCTAssertEqual(data["seq"] as? Int, 77)

        let forbidden = WorkSessionACPEvent(
            eventId: UUID(), type: "agent.partial", v: 1, ts: 1,
            payload: .object([
                "run_id": .string(sessionID.uuidString),
                "work_session_id": .string(sessionID.uuidString),
                "channel_id": .string(channelID.uuidString),
                "text_delta": .string("safe"),
                "_meta": .object(["acp": .object(["raw": .string("forbidden")])]),
            ])
        )
        XCTAssertThrowsError(
            try WorkSessionRoutes.validatedACPEvent(forbidden, sessionID: sessionID)
        )
    }

    func testTierFallbackPolicyAndResumeProjectionContracts() throws {
        XCTAssertEqual(try WorkTierPolicyRoutes.validatedMode("t1_only"), "t1_only")
        XCTAssertEqual(try WorkTierPolicyRoutes.validatedMode("ask"), "ask")
        XCTAssertEqual(try WorkTierPolicyRoutes.validatedMode("auto"), "auto")
        XCTAssertThrowsError(try WorkTierPolicyRoutes.validatedMode("always"))
        XCTAssertNil(try WorkTierPolicyRoutes.validatedAutoTarget(nil, mode: "ask"))
        XCTAssertEqual(
            try WorkTierPolicyRoutes.validatedAutoTarget(" CLOUD ", mode: "auto"),
            "cloud"
        )
        XCTAssertThrowsError(
            try WorkTierPolicyRoutes.validatedAutoTarget("cloud", mode: "ask")
        )
        XCTAssertThrowsError(
            try WorkTierPolicyRoutes.validatedAutoTarget(nil, mode: "auto")
        )

        let sourceID = UUID(uuidString: "00000000-0000-7000-8000-000000000519")!
        let resumedID = UUID(uuidString: "00000000-0000-7000-8000-000000000520")!
        let props = WorkSessionRoutes.cardProps(
            sessionID: resumedID,
            tool: "codex",
            label: "resume",
            status: "running",
            resumedFromSessionID: sourceID
        )
        XCTAssertEqual(props["resumed_from_session_id"] as? String, sourceID.uuidString)

        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let migration = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Migrations/025_work_tier_fallback.sql"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(migration.contains("CREATE TABLE work_tier_policy"))
        XCTAssertTrue(migration.contains("FORCE ROW LEVEL SECURITY"))
        XCTAssertTrue(migration.contains("resumed_from_session_id"))
        XCTAssertTrue(migration.contains("'orphaned'"))
        for forbidden in ["cwd", "attach_endpoint", "capability_token", "provider_credential"] {
            XCTAssertFalse(migration.contains(forbidden))
        }
    }

    func testTerminalAttachBindingCapabilityAndWireShape() throws {
        XCTAssertEqual(
            try RemotePTYBinding.validated(
                ptyID: "pty-511:primary",
                attachEndpoint: "wss://workd.momo.test/v1/pty"
            ),
            RemotePTYBinding(
                ptyID: "pty-511:primary",
                attachEndpoint: "wss://workd.momo.test/v1/pty"
            )
        )
        XCTAssertNil(try RemotePTYBinding.validated(ptyID: nil, attachEndpoint: nil))
        XCTAssertThrowsError(try RemotePTYBinding.validated(
            ptyID: "pty-511",
            attachEndpoint: nil
        ))
        XCTAssertThrowsError(try RemotePTYBinding.validated(
            ptyID: "../pty",
            attachEndpoint: "wss://workd.momo.test/v1/pty"
        ))
        for unsafeEndpoint in [
            "ws://workd.momo.test/v1/pty",
            "wss://user:secret@workd.momo.test/v1/pty",
            "wss://workd.momo.test/v1/pty?token=raw",
            "wss://workd.momo.test/v1/pty#secret",
            // MOMO-655: Foundation hands back an empty host, not nil, for an
            // authority-less URL, so `host != nil` alone let this through and a
            // client would have dialled its own origin instead of a host.
            "wss:///v1/pty",
        ] {
            XCTAssertThrowsError(try RemotePTYBinding.validated(
                ptyID: "pty-511",
                attachEndpoint: unsafeEndpoint
            ))
        }

        let token = TerminalAttachRoutes.mintCapabilityToken()
        XCTAssertNoThrow(try TerminalAttachRoutes.validatedCapabilityToken(token))
        XCTAssertThrowsError(try TerminalAttachRoutes.validatedCapabilityToken(
            "momo_terminal_attach_v1.not-a-token"
        )) { error in
            XCTAssertEqual((error as? HTTPError)?.status, .unauthorized)
        }

        let response = TerminalAttachCapabilityResponse(
            attachEndpoint: "wss://workd.momo.test/v1/pty",
            capabilityToken: token,
            ptyID: "pty-511"
        )
        let encoded = try JSONEncoder().encode(response)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        )
        XCTAssertEqual(object["attach_endpoint"] as? String, response.attachEndpoint)
        XCTAssertEqual(object["capability_token"] as? String, token)
        XCTAssertEqual(object["pty_id"] as? String, response.ptyID)
        XCTAssertNil(object["attachEndpoint"])
        XCTAssertNil(object["capabilityToken"])
        XCTAssertNil(object["expires_at"], "issue response stays the exact D10 three-field grant")

        let defaultRequest = try JSONDecoder().decode(
            IssueTerminalAttachRequest.self,
            from: Data("{}".utf8)
        )
        XCTAssertNil(defaultRequest.mode)
        let observerRequest = try JSONDecoder().decode(
            IssueTerminalAttachRequest.self,
            from: Data(#"{"mode":"observer"}"#.utf8)
        )
        XCTAssertEqual(observerRequest.mode, .observer)

        // MOMO-674: a host re-checking a stream it already holds opts in
        // explicitly, and a body that predates the field still means "a client
        // is dialling in right now" — the TTL-enforcing path.
        let dial = try JSONDecoder().decode(
            ValidateTerminalAttachRequest.self,
            from: Data(#"{"capability_token":"\#(token)"}"#.utf8)
        )
        XCTAssertNil(dial.stream)
        let revalidation = try JSONDecoder().decode(
            ValidateTerminalAttachRequest.self,
            from: Data(#"{"capability_token":"\#(token)","stream":true}"#.utf8)
        )
        XCTAssertEqual(revalidation.stream, true)

        let validation = TerminalAttachValidationResponse(
            workSessionID: UUID().uuidString,
            ptyID: "pty-511",
            expiresAt: "2026-07-21T00:00:00.000Z",
            mode: .observer
        )
        let validationObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(validation))
                as? [String: Any]
        )
        XCTAssertEqual(validationObject["mode"] as? String, "observer")
    }

    func testTerminalAttachMigrationAndRoutesKeepDirectStreamBoundary() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let migration = try String(
            contentsOf: serverRoot.appendingPathComponent("Migrations/023_terminal_attach.sql"),
            encoding: .utf8
        )
        XCTAssertTrue(migration.contains("ADD COLUMN pty_id text"))
        XCTAssertTrue(migration.contains("ADD COLUMN attach_endpoint text"))
        XCTAssertTrue(migration.contains("CREATE TABLE terminal_attach_capability"))
        XCTAssertTrue(migration.contains("token_hash       bytea NOT NULL UNIQUE"))
        XCTAssertTrue(migration.contains("expires_at       timestamptz NOT NULL"))
        XCTAssertTrue(migration.contains("FORCE ROW LEVEL SECURITY"))
        XCTAssertFalse(migration.contains("capability_token"))
        XCTAssertFalse(migration.contains("stdout"))
        XCTAssertFalse(migration.contains("stderr"))

        let observerMigration = try String(
            contentsOf: serverRoot.appendingPathComponent("Migrations/024_observer_attach.sql"),
            encoding: .utf8
        )
        XCTAssertTrue(observerMigration.contains("ADD COLUMN observation text NOT NULL DEFAULT 'open'"))
        XCTAssertTrue(observerMigration.contains("CHECK (observation IN ('open', 'owner_only'))"))
        XCTAssertTrue(observerMigration.contains("ADD COLUMN mode text NOT NULL DEFAULT 'controller'"))
        XCTAssertTrue(observerMigration.contains("CHECK (mode IN ('controller', 'observer'))"))
        XCTAssertFalse(observerMigration.contains("stdout"))
        XCTAssertFalse(observerMigration.contains("capability_token"))

        let routes = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Routes/TerminalAttachRoutes.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(routes.contains("digest(\\(token), 'sha256')"))
        XCTAssertTrue(routes.contains("c.expires_at > clock_timestamp()"))
        XCTAssertTrue(routes.contains("h.revoked_at IS NULL"))
        // MOMO-674: revalidation relaxes the dial window and NOTHING else. The
        // clauses that decide who may watch stay inside the same join, so a
        // stream that outlives the TTL is still cut the moment the session ends,
        // the host is revoked, observation closes, or the grantee leaves.
        XCTAssertTrue(
            routes.contains("AND (\\(revalidating) OR c.expires_at > clock_timestamp())"),
            "only the expiry clause may be conditional on stream revalidation"
        )
        XCTAssertFalse(
            routes.contains("\\(revalidating) OR h.revoked_at IS NULL"),
            "host revocation is never relaxed for an open stream"
        )
        XCTAssertFalse(
            routes.contains("\\(revalidating) OR ws.status"),
            "session state is never relaxed for an open stream"
        )
        XCTAssertFalse(
            routes.contains("\\(revalidating) OR ws.observation"),
            "observation scope is never relaxed for an open stream"
        )
        XCTAssertTrue(routes.contains("ws.status IN ('running', 'idle')"))
        XCTAssertTrue(routes.contains("only the session owner can attach"))
        XCTAssertTrue(routes.contains("terminal attach requires a human bearer"))
        XCTAssertTrue(routes.contains("work.terminal_attach.issued"))
        XCTAssertTrue(routes.contains("work.session.observer"))
        XCTAssertTrue(routes.contains("c.mode = 'observer'"))
        XCTAssertTrue(routes.contains("ws.observation = 'open'"))
        XCTAssertFalse(routes.contains("CentrifugoClient"))
        XCTAssertTrue(routes.contains("INSERT INTO outbox"), "count-only observer projection uses the relay")
        XCTAssertFalse(routes.contains("/api/publish"))
        XCTAssertFalse(routes.contains("router.websocket"))

        let workspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let hostID = UUID(uuidString: "00000000-0000-7000-8000-000000000511")!
        let validatePath = "/v1/workspaces/\(workspaceID.uuidString.lowercased())/work-hosts/\(hostID.uuidString.lowercased())/terminal-attach/validate"
        XCTAssertTrue(WorkHostAuthenticator.isAllowed(method: "POST", path: validatePath))
        XCTAssertEqual(WorkHostAuthenticator.scopedHostID(fromPath: validatePath), hostID)

        let observerPayload = TerminalAttachRoutes.observerPayload(
            workspaceID: workspaceID,
            channelID: UUID(uuidString: "00000000-0000-7000-8000-000000000201")!,
            sessionID: UUID(uuidString: "00000000-0000-7000-8000-000000000516")!,
            observerCount: 3,
            grantID: UUID(uuidString: "00000000-0000-7000-8000-000000000558")!,
            timestampMs: 1_783_000_000_000
        )
        let observerObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(observerPayload.utf8)) as? [String: Any]
        )
        XCTAssertNil(observerObject["version"])
        let observerData = try XCTUnwrap(observerObject["data"] as? [String: Any])
        XCTAssertEqual(observerData["type"] as? String, "work.session.observer")
        let observerBody = try XCTUnwrap(observerData["payload"] as? [String: Any])
        XCTAssertEqual(observerBody["observer_count"] as? Int, 3)
        XCTAssertEqual(Set(observerBody.keys), ["session_id", "observer_count"])
    }

    func testWorkControlRouteScopeAndClosedPayloadValidation() throws {
        XCTAssertEqual(
            AuthMiddleware.requiredAgentScope(
                method: "POST",
                path: "/v1/workspaces/ws/work-controls"
            ),
            "work:control"
        )
        XCTAssertEqual(
            AuthMiddleware.requiredAgentScope(
                method: "POST",
                path: "/v1/workspaces/ws/work-controls/control/ack"
            ),
            "work:control"
        )
        XCTAssertNil(AuthMiddleware.requiredAgentScope(
            method: "PUT",
            path: "/v1/workspaces/ws/work-auto-approvals/codex"
        ))
        XCTAssertNil(AuthMiddleware.requiredAgentScope(
            method: "GET",
            path: "/v1/workspaces/ws/work-auto-approvals"
        ))
        XCTAssertTrue(AgentCredentialRoutes.defaultScopes.contains("work:control"))

        let spawn = try WorkControlRoutes.validatedPayload(
            .object([
                "tool": .string("codex"),
                "label": .string("  ship MOMO-484  "),
            ]),
            kind: .spawn
        )
        XCTAssertEqual(spawn.value, .object([
            "tool": .string("codex"),
            "label": .string("ship MOMO-484"),
        ]))
        XCTAssertThrowsError(try WorkControlRoutes.validatedPayload(
            .object([
                "tool": .string("codex"),
                "label": .string("unsafe"),
                "cwd": .string("/tmp/repo"),
            ]),
            kind: .spawn
        ))
        XCTAssertThrowsError(try WorkControlRoutes.validatedPayload(
            .object([
                "text": .string("go"),
                "env": .object(["TOKEN": .string("secret")]),
            ]),
            kind: .input
        ))
        XCTAssertEqual(
            try WorkControlRoutes.validatedPayload(
                .object(["tail_lines": .int(200)]),
                kind: .read
            ).value,
            .object(["tail_lines": .int(200)])
        )
        XCTAssertThrowsError(try WorkControlRoutes.validatedPayload(
            .object(["tail_lines": .string("200")]),
            kind: .read
        ))
        XCTAssertEqual(
            try WorkControlRoutes.validatedPayload(.object([:]), kind: .kill).value,
            .object([:])
        )

        let ownerID = UUID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let otherID = UUID(uuidString: "00000000-0000-7000-8000-000000000104")!
        XCTAssertNoThrow(try WorkControlRoutes.validateTargetHostScope(
            scope: "workspace",
            ownerMemberID: otherID,
            sessionOwnerMemberID: ownerID
        ))
        XCTAssertNoThrow(try WorkControlRoutes.validateTargetHostScope(
            scope: "member",
            ownerMemberID: ownerID,
            sessionOwnerMemberID: ownerID
        ))
        XCTAssertThrowsError(try WorkControlRoutes.validateTargetHostScope(
            scope: "member",
            ownerMemberID: otherID,
            sessionOwnerMemberID: ownerID
        )) { error in
            XCTAssertEqual((error as? HTTPError)?.status, .forbidden)
        }
    }

    func testWorkControlMigrationAndNoVersionEventsKeepApprovalBoundary() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let migration = try String(
            contentsOf: serverRoot.appendingPathComponent("Migrations/020_work_control.sql"),
            encoding: .utf8
        )
        XCTAssertTrue(migration.contains("CREATE TABLE work_control"))
        XCTAssertTrue(migration.contains("CREATE TABLE work_auto_approve"))
        XCTAssertTrue(migration.contains("payload - ARRAY['tool', 'label']"))
        XCTAssertTrue(migration.contains("payload - ARRAY['text']"))
        XCTAssertTrue(migration.contains("payload - ARRAY['tail_lines']"))
        XCTAssertTrue(migration.contains("FORCE ROW LEVEL SECURITY"))

        let control = WorkControlDTO(
            id: "00000000-0000-7000-8000-000000000484",
            workspaceId: "00000000-0000-7000-8000-000000000001",
            channelId: "00000000-0000-7000-8000-000000000201",
            requesterMemberId: "00000000-0000-7000-8000-000000000103",
            targetHostId: "00000000-0000-7000-8000-000000000901",
            sessionId: nil,
            kind: "spawn",
            payload: .object([
                "tool": .string("codex"),
                "label": .string("MOMO-484"),
            ]),
            status: "dispatched",
            approvalMessageId: "00000000-0000-7000-8000-000000000701",
            createdAtMs: 1_784_452_800_000,
            updatedAtMs: 1_784_452_801_000
        )
        for (eventType, raw) in [
            ("work.control.dispatched", WorkControlRoutes.dispatchPayload(
                workspaceID: UUID(uuidString: control.workspaceId)!,
                control: control
            )),
            ("work.control.acked", WorkControlRoutes.ackPayload(
                workspaceID: UUID(uuidString: control.workspaceId)!,
                control: control,
                ok: false,
                errorLabel: "host_unavailable"
            )),
        ] {
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any]
            )
            XCTAssertNil(object["version"])
            XCTAssertNotNil(object["idempotency_key"] as? String)
            let data = try XCTUnwrap(object["data"] as? [String: Any])
            XCTAssertNil(data["seq"])
            XCTAssertEqual(data["type"] as? String, eventType)
            let payload = try XCTUnwrap(data["payload"] as? [String: Any])
            XCTAssertEqual(payload["control_id"] as? String, control.id)
            XCTAssertEqual(payload["target_host_id"] as? String, control.targetHostId)
            XCTAssertEqual(payload["kind"] as? String, "spawn")
            let spawnPayload = try XCTUnwrap(payload["payload"] as? [String: Any])
            XCTAssertEqual(spawnPayload["tool"] as? String, "codex")
            XCTAssertEqual(spawnPayload["label"] as? String, "MOMO-484")
        }

        let routes = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Routes/WorkControlRoutes.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(routes.contains("only dispatched controls can be acknowledged"))
        XCTAssertTrue(routes.contains("wc.status = 'pending_approval'"))
        XCTAssertTrue(routes.contains("root.status = 'acked'"))
        XCTAssertTrue(routes.contains("work host not found"))
        XCTAssertTrue(routes.contains("member-scoped work host belongs to another session owner"))
        XCTAssertTrue(routes.contains("only the registered host owner can acknowledge"))
        XCTAssertTrue(routes.contains("work host cannot acknowledge another host control"))
        XCTAssertTrue(routes.contains("ws.member_id = a.owner_human_id"))
        XCTAssertTrue(routes.contains("errorLabel: \"host_revoked\""))
        XCTAssertTrue(routes.contains("SET status = 'failed'"))
        XCTAssertGreaterThanOrEqual(
            routes.components(separatedBy: "AND revoked_at IS NULL").count - 1,
            3
        )
        XCTAssertTrue(routes.contains("work.auto_approve.enabled"))
        XCTAssertTrue(routes.contains("work.auto_approve.disabled"))
        XCTAssertFalse(routes.contains("BYPASSRLS"))
    }

    func testWorkHostMigrationRoutesAndClosedCapabilityBoundary() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let migration = try String(
            contentsOf: serverRoot.appendingPathComponent("Migrations/021_work_host.sql"),
            encoding: .utf8
        )
        XCTAssertTrue(migration.contains("CREATE TABLE work_host"))
        XCTAssertTrue(migration.contains("scope IN ('member', 'workspace')"))
        XCTAssertTrue(migration.contains("type IN ('app', 'workd', 'cloud')"))
        XCTAssertTrue(migration.contains("length(btrim(display_name)) BETWEEN 1 AND 80"))
        XCTAssertTrue(migration.contains("public_key ~ '^[A-Za-z0-9+/]{43}=$'"))
        XCTAssertTrue(migration.contains("ARRAY['work_host']"))
        XCTAssertTrue(migration.contains("ALTER TABLE %I FORCE ROW LEVEL SECURITY"))
        XCTAssertTrue(migration.contains("jsonb_path_exists"))
        XCTAssertTrue(migration.contains(#"@.type() != "boolean""#))
        XCTAssertTrue(migration.contains("ADD CONSTRAINT work_session_host_fk"))
        XCTAssertTrue(migration.contains("ADD CONSTRAINT work_control_target_host_fk"))
        XCTAssertEqual(migration.components(separatedBy: "NOT VALID").count - 1, 2)
        XCTAssertEqual(migration.components(separatedBy: "VALIDATE CONSTRAINT").count - 1, 2)
        XCTAssertFalse(migration.contains("private_key"))

        let routes = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Routes/WorkHostRoutes.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(routes.contains("work-hosts/:host/heartbeat"))
        XCTAssertTrue(routes.contains("work-hosts/:host/pending-controls"))
        XCTAssertTrue(routes.contains("wc.status = 'dispatched'"))
        XCTAssertTrue(routes.contains("work.host.registered"))
        XCTAssertTrue(routes.contains("work.host.revoked"))
        XCTAssertTrue(routes.contains("capabilities: [String: Bool]"))
        XCTAssertTrue(routes.contains("revoked_at IS NULL"))
        XCTAssertFalse(routes.contains("BYPASSRLS"))

        XCTAssertEqual(try WorkHostRoutes.validatedScope(" Workspace "), "workspace")
        XCTAssertThrowsError(try WorkHostRoutes.validatedScope("channel"))
        XCTAssertEqual(try WorkHostRoutes.validatedType("WORKD"), "workd")
        XCTAssertThrowsError(try WorkHostRoutes.validatedType("ssh"))
        XCTAssertEqual(try WorkHostRoutes.validatedDisplayName(" Team VPS "), "Team VPS")
        XCTAssertThrowsError(try WorkHostRoutes.validatedDisplayName("   "))
        XCTAssertThrowsError(
            try WorkHostRoutes.validatedDisplayName(String(repeating: "x", count: 81))
        )
        XCTAssertEqual(
            try WorkHostRoutes.validatedCapabilities(["tool.codex": true]),
            ["tool.codex": true]
        )
        XCTAssertThrowsError(try WorkHostRoutes.validatedCapabilities(["tool/codex": true]))
    }

    func testWorkPoolMigrationRoutesAndSettingsKeepDerivedUsageBoundary() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let migration = try String(
            contentsOf: serverRoot.appendingPathComponent("Migrations/022_work_pool.sql"),
            encoding: .utf8
        )
        XCTAssertTrue(migration.contains("CREATE TABLE work_pool"))
        XCTAssertTrue(migration.contains("workspace_id              uuid PRIMARY KEY"))
        XCTAssertTrue(migration.contains("max_active                int NOT NULL DEFAULT 5"))
        XCTAssertTrue(migration.contains("included_active_hours     int"))
        XCTAssertTrue(migration.contains("per_member_soft_limit     int NOT NULL DEFAULT 5"))
        XCTAssertTrue(migration.contains("SELECT id FROM workspace"))
        XCTAssertTrue(migration.contains("ON CONFLICT (workspace_id) DO NOTHING"))
        XCTAssertTrue(migration.contains("WHERE status = 'running'"))
        XCTAssertTrue(migration.contains("ALTER TABLE work_pool FORCE ROW LEVEL SECURITY"))
        XCTAssertFalse(migration.contains("active_count"))
        XCTAssertFalse(migration.contains("active_sessions int"))

        let routes = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Routes/WorkPoolRoutes.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(routes.contains("work-pool\", use: get"))
        XCTAssertTrue(routes.contains("work-pool\", use: update"))
        XCTAssertTrue(routes.contains("FROM work_session"))
        XCTAssertTrue(routes.contains("status IN ('running', 'idle')"))
        XCTAssertTrue(routes.contains("FOR UPDATE"))
        XCTAssertTrue(routes.contains("pool_exhausted"))
        XCTAssertTrue(routes.contains("member_limit"))
        XCTAssertTrue(routes.contains("work.pool.updated"))
        XCTAssertTrue(routes.contains("max_active_increased"))
        XCTAssertTrue(routes.contains("Automatic queue"))
        XCTAssertFalse(routes.contains("BYPASSRLS"))

        XCTAssertEqual(
            try WorkPoolRoutes.validatedSettings(
                maxActive: 8,
                includedActiveHours: 120,
                perMemberSoftLimit: 3
            ),
            WorkPoolRoutes.Settings(
                maxActive: 8,
                includedActiveHours: 120,
                perMemberSoftLimit: 3
            )
        )
        XCTAssertThrowsError(try WorkPoolRoutes.validatedSettings(
            maxActive: 0,
            includedActiveHours: nil,
            perMemberSoftLimit: 1
        ))
        XCTAssertThrowsError(try WorkPoolRoutes.validatedSettings(
            maxActive: 5,
            includedActiveHours: -1,
            perMemberSoftLimit: 1
        ))
        XCTAssertThrowsError(try WorkPoolRoutes.validatedSettings(
            maxActive: 5,
            includedActiveHours: nil,
            perMemberSoftLimit: 6
        ))
    }

    func testWorkHostEd25519HeartbeatBindsWorkspaceHostAndTimestamp() throws {
        let workspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let hostID = UUID(uuidString: "00000000-0000-7000-8000-000000000487")!
        let sentAtMs: Int64 = 1_784_582_400_000
        let privateKey = Curve25519.Signing.PrivateKey()
        let publicKey = privateKey.publicKey.rawRepresentation.base64EncodedString()
        let payload = WorkHostRoutes.heartbeatSigningPayload(
            workspaceID: workspaceID,
            hostID: hostID,
            sentAtMs: sentAtMs
        )
        let signature = try privateKey.signature(for: payload).base64EncodedString()

        XCTAssertEqual(try WorkHostRoutes.validatedPublicKey(publicKey), publicKey)
        XCTAssertThrowsError(try WorkHostRoutes.validatedPublicKey("not-a-key"))
        XCTAssertTrue(WorkHostRoutes.verifyHeartbeatSignature(
            publicKey: publicKey,
            signature: signature,
            workspaceID: workspaceID,
            hostID: hostID,
            sentAtMs: sentAtMs
        ))
        XCTAssertFalse(WorkHostRoutes.verifyHeartbeatSignature(
            publicKey: publicKey,
            signature: signature,
            workspaceID: workspaceID,
            hostID: UUID(),
            sentAtMs: sentAtMs
        ))
        XCTAssertFalse(WorkHostRoutes.verifyHeartbeatSignature(
            publicKey: publicKey,
            signature: signature,
            workspaceID: workspaceID,
            hostID: hostID,
            sentAtMs: sentAtMs + 1
        ))

        let now = Date(timeIntervalSince1970: Double(sentAtMs) / 1_000)
        XCTAssertNoThrow(try WorkHostRoutes.validateHeartbeatTimestamp(sentAtMs, now: now))
        XCTAssertThrowsError(try WorkHostRoutes.validateHeartbeatTimestamp(
            sentAtMs - WorkHostRoutes.heartbeatClockSkewMs - 1,
            now: now
        )) { error in
            XCTAssertEqual((error as? HTTPError)?.status, .unauthorized)
        }
    }

    func testWorkHostSignedRequestV2BindsBodyDigestAndRequestID() throws {
        let workspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let hostID = UUID(uuidString: "00000000-0000-7000-8000-000000000488")!
        let requestID = UUID(uuidString: "00000000-0000-7000-8000-000000000657")!
        let sentAtMs: Int64 = 1_784_582_400_000
        let path = "/v1/workspaces/\(workspaceID.uuidString.lowercased())/work-hosts/\(hostID.uuidString.lowercased())/pending-controls"
        let bodyDigest = WorkHostAuthenticator.sha256Hex(Data())
        let privateKey = Curve25519.Signing.PrivateKey()
        let publicKey = privateKey.publicKey.rawRepresentation.base64EncodedString()
        let payload = WorkHostAuthenticator.requestSigningPayload(
            method: "GET",
            path: path,
            workspaceID: workspaceID,
            hostID: hostID,
            sentAtMs: sentAtMs,
            bodyDigest: bodyDigest,
            requestID: requestID
        )
        XCTAssertEqual(
            String(decoding: payload, as: UTF8.self),
            "momo.work_host.request.v2\nGET\n\(path)\n\(workspaceID.uuidString.lowercased())\n\(hostID.uuidString.lowercased())\n\(sentAtMs)\n\(bodyDigest)\n\(requestID.uuidString.lowercased())"
        )
        let signature = try privateKey.signature(for: payload).base64EncodedString()
        XCTAssertTrue(WorkHostAuthenticator.verifySignature(
            publicKey: publicKey,
            signature: signature,
            method: "GET",
            path: path,
            workspaceID: workspaceID,
            hostID: hostID,
            sentAtMs: sentAtMs,
            bodyDigest: bodyDigest,
            requestID: requestID
        ))
        XCTAssertFalse(WorkHostAuthenticator.verifySignature(
            publicKey: publicKey,
            signature: signature,
            method: "POST",
            path: path,
            workspaceID: workspaceID,
            hostID: hostID,
            sentAtMs: sentAtMs,
            bodyDigest: bodyDigest,
            requestID: requestID
        ))
        XCTAssertEqual(
            WorkHostAuthenticator.hostID(
                fromAuthorization: "MomoHost \(hostID.uuidString.lowercased())"
            ),
            hostID
        )
        XCTAssertTrue(WorkHostAuthenticator.isAllowed(method: "GET", path: path))
        XCTAssertTrue(WorkHostAuthenticator.isAllowed(
            method: "POST",
            path: "/v1/workspaces/\(workspaceID)/work-sessions"
        ))
        XCTAssertFalse(WorkHostAuthenticator.isAllowed(
            method: "POST",
            path: "/v1/workspaces/\(workspaceID)/channels/\(UUID())/messages"
        ))
        let now = Date(timeIntervalSince1970: Double(sentAtMs) / 1_000)
        XCTAssertNoThrow(try WorkHostAuthenticator.validateTimestamp(sentAtMs, now: now))
        XCTAssertThrowsError(try WorkHostAuthenticator.validateTimestamp(
            sentAtMs + WorkHostRoutes.heartbeatClockSkewMs + 1,
            now: now
        ))
    }

    func testWorkHostSignedRequestRejectsBodySubstitutionByName() throws {
        let workspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let hostID = UUID(uuidString: "00000000-0000-7000-8000-000000000488")!
        let requestID = UUID(uuidString: "00000000-0000-7000-8000-000000000657")!
        let sentAtMs: Int64 = 1_784_582_400_000
        let path = "/v1/workspaces/\(workspaceID.uuidString.lowercased())/work-sessions/\(UUID().uuidString.lowercased())"
        let signedBody = Data(#"{"exitCode":0,"status":"idle"}"#.utf8)
        let substitutedBody = Data(#"{"status":"ended"}"#.utf8)
        let privateKey = Curve25519.Signing.PrivateKey()
        let publicKey = privateKey.publicKey.rawRepresentation.base64EncodedString()
        let signature = try privateKey.signature(for: WorkHostAuthenticator.requestSigningPayload(
            method: "PATCH",
            path: path,
            workspaceID: workspaceID,
            hostID: hostID,
            sentAtMs: sentAtMs,
            bodyDigest: WorkHostAuthenticator.sha256Hex(signedBody),
            requestID: requestID
        )).base64EncodedString()

        XCTAssertFalse(
            WorkHostAuthenticator.verifySignature(
                publicKey: publicKey,
                signature: signature,
                method: "PATCH",
                path: path,
                workspaceID: workspaceID,
                hostID: hostID,
                sentAtMs: sentAtMs,
                bodyDigest: WorkHostAuthenticator.sha256Hex(substitutedBody),
                requestID: requestID
            ),
            "body substitution must invalidate the named v2 signature assertion"
        )
    }

    func testWorkHostRequestReplayMigrationIsTenantScopedAtomicAndPrunable() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let migration = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Migrations/048_work_host_request_replay.sql"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(migration.contains("PRIMARY KEY (workspace_id, request_id)"))
        XCTAssertTrue(migration.contains("work_host_request_expiry_idx"))
        XCTAssertTrue(migration.contains("FOREACH t IN ARRAY ARRAY['work_host_request']"))
        XCTAssertTrue(migration.contains("FORCE ROW LEVEL SECURITY"))
        XCTAssertTrue(migration.contains("CREATE POLICY ws_isolation ON %I"))
        XCTAssertTrue(migration.contains("interval '5 minutes'"))

        let authenticator = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Auth/WorkHostAuthenticator.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(authenticator.contains("ON CONFLICT (workspace_id, request_id) DO NOTHING"))
        XCTAssertTrue(authenticator.contains("DELETE FROM work_host_request"))
        XCTAssertTrue(authenticator.contains("interval '10 minutes'"))
        XCTAssertFalse(authenticator.contains("BYPASSRLS"))
    }

    func testThreadRepliesBoundaryCursorMembershipAndRLSContracts() throws {
        XCTAssertNil(try MessageRoutes.repliesCursor(nil))
        XCTAssertNil(try MessageRoutes.repliesCursor("  "))
        XCTAssertEqual(try MessageRoutes.repliesCursor("42"), 42)
        XCTAssertThrowsError(try MessageRoutes.repliesCursor("-1")) { error in
            XCTAssertEqual((error as? HTTPError)?.status, .badRequest)
        }
        XCTAssertThrowsError(
            try MessageRoutes.validateRepliesRoot(found: false, parentRootID: nil)
        ) { error in
            XCTAssertEqual((error as? HTTPError)?.status, .notFound)
        }
        XCTAssertThrowsError(
            try MessageRoutes.validateRepliesRoot(found: true, parentRootID: UUID())
        ) { error in
            XCTAssertEqual((error as? HTTPError)?.status, .badRequest)
        }
        XCTAssertNoThrow(try MessageRoutes.validateRepliesRoot(found: true, parentRootID: nil))
        XCTAssertEqual(MessageRoutes.repliesMembershipError().status, .forbidden)

        let testFile = URL(fileURLWithPath: #filePath)
        let serverRoot = testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let source = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Routes/MessageRoutes.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(source.contains("messages/:root/replies"))
        XCTAssertTrue(source.contains("withTenantConnection"))
        XCTAssertTrue(source.contains("hasActiveMembership"))
        XCTAssertTrue(source.contains("AND m.root_id = \\(rootID)"))
        XCTAssertTrue(source.contains("ORDER BY m.seq ASC"))
        XCTAssertTrue(source.contains("LEFT JOIN thread t"))
        XCTAssertTrue(source.contains("t.reply_count > 0"))
        XCTAssertFalse(source.contains("BYPASSRLS"))
    }

    func testMessageAttachmentProjectionIsCompleteOnlyAggregatedAndDownloadSafe() throws {
        let attachmentID = UUID(uuidString: "00000000-0000-7000-8000-000000000180")!
        let projection = try XCTUnwrap(MessageRoutes.attachmentProjection(
            #"[{"id":"00000000-0000-7000-8000-000000000180","name":"evidence.txt","mime":"text/plain","sizeBytes":19}]"#
        ))
        XCTAssertEqual(projection, [MessageAttachmentDTO(
            id: attachmentID.uuidString,
            name: "evidence.txt",
            mime: "text/plain",
            sizeBytes: 19
        )])
        XCTAssertNil(try MessageRoutes.attachmentProjection(nil))
        XCTAssertNil(try MessageRoutes.attachmentProjection("[]"))

        let testFile = URL(fileURLWithPath: #filePath)
        let serverRoot = testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let source = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Routes/MessageRoutes.swift"
            ),
            encoding: .utf8
        )
        XCTAssertEqual(
            source.components(separatedBy: "LEFT JOIN LATERAL").count - 1,
            4,
            "history's three variants and replies must aggregate attachments in their query"
        )
        XCTAssertGreaterThanOrEqual(
            source.components(separatedBy: "jsonb_agg(").count - 1,
            5,
            "send plus the four list projections must aggregate without per-message queries"
        )
        XCTAssertTrue(source.contains("AND a.status = 'complete'"))
        XCTAssertTrue(source.contains("AND status = 'complete'"))
        XCTAssertTrue(source.contains("ORDER BY a.created_at ASC, a.id ASC"))
        XCTAssertFalse(source.contains("'uploadUrl'"))
        XCTAssertFalse(source.contains("'upload_url'"))
    }

    func testAgentMentionDetectionSupportsDisplayNameHandleAndMemberID() {
        let agentID = UUID(uuidString: "00000000-0000-7000-8000-000000000102")!

        XCTAssertTrue(MessageRoutes.containsAgentMention(
            "@김인턴 런타임 확인해줘",
            handle: "kim-intern",
            displayName: "김인턴",
            memberID: agentID
        ))
        XCTAssertTrue(MessageRoutes.containsAgentMention(
            "Can @KIM-INTERN check this?",
            handle: "kim-intern",
            displayName: "김인턴",
            memberID: agentID
        ))
        XCTAssertTrue(MessageRoutes.containsAgentMention(
            "<@00000000-0000-7000-8000-000000000102> please respond",
            handle: "kim-intern",
            displayName: "김인턴",
            memberID: agentID
        ))
        XCTAssertFalse(MessageRoutes.containsAgentMention(
            "@kim-internship is a different token",
            handle: "kim-intern",
            displayName: "김인턴",
            memberID: agentID
        ))
        XCTAssertFalse(MessageRoutes.containsAgentMention(
            "No agent mention here",
            handle: "kim-intern",
            displayName: "김인턴",
            memberID: agentID
        ))
    }

    func testReadStateBulkProjectionTracksHeadAndMissingCursor() throws {
        XCTAssertEqual(ReadStateRoutes.unreadCount(latest: 7, lastRead: 0), 7)
        XCTAssertEqual(ReadStateRoutes.unreadCount(latest: 7, lastRead: 2), 5)
        XCTAssertEqual(
            ReadStateRoutes.unreadCount(latest: 8, lastRead: 2),
            6,
            "an appended message must increase the server-computed unread count"
        )
        XCTAssertEqual(ReadStateRoutes.unreadCount(latest: 7, lastRead: 9), 0)

        let state = ReadStateDTO(
            channelId: "00000000-0000-7000-8000-000000000202",
            lastReadSeq: 0,
            latestSeq: 7,
            unreadCount: 7,
            mentionCount: 0
        )
        let data = try JSONEncoder().encode(ReadStateListResponseDTO(readStates: [state]))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        let states = try XCTUnwrap(object["read_states"] as? [[String: Any]])
        XCTAssertEqual(states.count, 1)
        XCTAssertEqual(states[0]["channel_id"] as? String, state.channelId)
        XCTAssertEqual(states[0]["last_read_seq"] as? Int, 0)
        XCTAssertEqual(states[0]["latest_seq"] as? Int, 7)
        XCTAssertEqual(states[0]["unread_count"] as? Int, 7)
        XCTAssertNil(states[0]["body"], "bulk read-state must not carry message bodies")
    }

    func testReadStateMarkReadIsMonotonicIdempotentAndHeadBounded() {
        XCTAssertEqual(ReadStateRoutes.effectiveCursor(current: 4, requested: 8, latest: 8), 8)
        XCTAssertEqual(
            ReadStateRoutes.effectiveCursor(current: 8, requested: 4, latest: 8),
            8,
            "a lower retry must be a no-op"
        )
        XCTAssertEqual(
            ReadStateRoutes.effectiveCursor(current: 8, requested: 8, latest: 8),
            8,
            "an equal retry must be idempotent"
        )
        XCTAssertEqual(
            ReadStateRoutes.effectiveCursor(current: 8, requested: 99, latest: 10),
            10,
            "a client must not advance beyond the authoritative channel head"
        )
    }

    func testReadStateMentionIDsAreServerOwnedArrayProps() throws {
        let mentioned = UUID(uuidString: "00000000-0000-7000-8000-000000000104")!
        let spoofed = MessageRoutes.encodeProps([
            "mention_member_ids": mentioned.uuidString,
            "client_key": "preserved",
        ])
        let spoofedObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(spoofed.utf8)) as? [String: Any]
        )
        XCTAssertNil(spoofedObject["mention_member_ids"])
        XCTAssertEqual(spoofedObject["client_key"] as? String, "preserved")

        let parsed = MessageRoutes.encodeProps(
            ["mention_member_ids": "foreign"],
            mentionMemberIDs: [mentioned]
        )
        let parsedObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(parsed.utf8)) as? [String: Any]
        )
        XCTAssertEqual(parsedObject["mention_member_ids"] as? [String], [mentioned.uuidString])
    }

    func testReadStateActorBindingIgnoresForeignMemberBodyAndPublishesPersonally() throws {
        let workspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let actorID = UUID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let foreignID = UUID(uuidString: "00000000-0000-7000-8000-000000000104")!
        let channelID = "00000000-0000-7000-8000-000000000202"
        let injectedBody = Data(
            "{\"last_read_seq\":9,\"member_id\":\"\(foreignID.uuidString)\"}".utf8
        )
        let request = try JSONDecoder().decode(UpdateReadStateRequestDTO.self, from: injectedBody)
        XCTAssertEqual(request.lastReadSeq, 9)
        XCTAssertEqual(ReadStateRoutes.channelMembershipError().status, .forbidden)

        let state = ReadStateDTO(
            channelId: channelID,
            lastReadSeq: request.lastReadSeq,
            latestSeq: 11,
            unreadCount: 2,
            mentionCount: 1
        )
        let raw = ReadStateRoutes.broadcastPayload(
            workspaceID: workspaceID,
            memberID: actorID,
            state: state,
            timestampMs: 1_783_917_600_000
        )
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any]
        )
        XCTAssertEqual(
            object["channel"] as? String,
            "user:read-state#\(actorID.uuidString)"
        )
        XCTAssertNil(object["version"], "personal read-state events are not message-seq streams")
        let data = try XCTUnwrap(object["data"] as? [String: Any])
        XCTAssertEqual(data["type"] as? String, "read_state")
        let payload = try XCTUnwrap(data["payload"] as? [String: Any])
        XCTAssertEqual(payload["member_id"] as? String, actorID.uuidString)
        XCTAssertEqual(payload["channel_id"] as? String, channelID)
        XCTAssertEqual(payload["last_read_seq"] as? Int, 9)
        XCTAssertFalse(raw.contains(foreignID.uuidString))
    }

    func testReadStateRLSAndUserLimitedChannelStaticContracts() throws {
        let testFile = URL(fileURLWithPath: #filePath)
        let serverRoot = testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let migration = try String(
            contentsOf: serverRoot.appendingPathComponent("Migrations/001_init.sql"),
            encoding: .utf8
        )
        XCTAssertTrue(migration.contains("'read_state'"))
        XCTAssertTrue(migration.contains("ALTER TABLE %I FORCE ROW LEVEL SECURITY"))
        XCTAssertTrue(migration.contains("current_setting('app.workspace_id', true)::uuid"))

        let routeSource = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Routes/ReadStateRoutes.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(routeSource.contains("withTenantConnection"))
        XCTAssertTrue(routeSource.contains("withTenantTransaction"))
        XCTAssertTrue(routeSource.contains("FOR UPDATE OF ms"))
        XCTAssertTrue(routeSource.contains("jsonb_typeof(props->'mention_member_ids') = 'array'"))
        XCTAssertFalse(routeSource.contains("withPlatformReadConnection"))

        let repoRoot = serverRoot.deletingLastPathComponent()
        for relativePath in ["infra/centrifugo.json", "infra/prod/centrifugo.prod.json"] {
            let data = try Data(contentsOf: repoRoot.appendingPathComponent(relativePath))
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: data) as? [String: Any]
            )
            let channel = try XCTUnwrap(object["channel"] as? [String: Any])
            let namespaces = try XCTUnwrap(channel["namespaces"] as? [[String: Any]])
            let user = try XCTUnwrap(namespaces.first { $0["name"] as? String == "user" })
            XCTAssertEqual(user["allow_user_limited_channels"] as? Bool, true)
        }
    }

    func testCostSnapshotDTOEncodesSnakeCaseProjectionContract() throws {
        let snapshot = CostSnapshotDTO(
            runId: "00000000-0000-7000-8000-000000000904",
            reservedMicroUSD: 0,
            spentMicroUSD: 6,
            softLimitMicroUSD: 900_000,
            hardLimitMicroUSD: 1_000_000,
            isReconciled: true,
            wasEstimated: false,
            limitState: "normal"
        )
        let page = CostSnapshotPageDTO(
            schema: "momo.cost_snapshot.channel.v0",
            channelId: "00000000-0000-7000-8000-000000000202",
            snapshots: [snapshot],
            asOfMs: 1_782_463_260_000
        )

        let object = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(page)
        ) as? [String: Any]
        let snapshots = object?["snapshots"] as? [[String: Any]]
        let item = snapshots?.first

        XCTAssertEqual(object?["channel_id"] as? String, page.channelId)
        XCTAssertEqual(item?["run_id"] as? String, snapshot.runId)
        XCTAssertEqual(item?["reserved_micro_usd"] as? Int, 0)
        XCTAssertEqual(item?["spent_micro_usd"] as? Int, 6)
        XCTAssertEqual(item?["soft_limit_micro_usd"] as? Int, 900_000)
        XCTAssertEqual(item?["hard_limit_micro_usd"] as? Int, 1_000_000)
        XCTAssertEqual(item?["is_reconciled"] as? Bool, true)
        XCTAssertEqual(item?["was_estimated"] as? Bool, false)
        XCTAssertEqual(item?["limit_state"] as? String, "normal")
        XCTAssertNil(item?["reservedMicroUSD"])
    }

    func testCostProjectionLimitStateHelper() {
        XCTAssertEqual(
            CostProjectionRoutes.limitState(
                observedMicroUSD: 10,
                softLimitMicroUSD: 20,
                hardLimitMicroUSD: 30
            ),
            "normal"
        )
        XCTAssertEqual(
            CostProjectionRoutes.limitState(
                observedMicroUSD: 25,
                softLimitMicroUSD: 20,
                hardLimitMicroUSD: 30
            ),
            "soft_limit"
        )
        XCTAssertEqual(
            CostProjectionRoutes.limitState(
                observedMicroUSD: 30,
                softLimitMicroUSD: 20,
                hardLimitMicroUSD: 30
            ),
            "hard_limit"
        )
    }

    // ---- MOMO-300: proxy secret / revocation / rate limit units ----

    func testSharedConstantTimeEquals() {
        // Shared helper — used by both the subscribe-proxy secret check and
        // the platform-admin login secret check (review fix: no plain `==`).
        XCTAssertTrue(ConstantTime.equals("secret-a", "secret-a"))
        XCTAssertFalse(ConstantTime.equals("secret-a", "secret-b"))
        XCTAssertFalse(ConstantTime.equals("secret-a", "secret-a-longer"))
        XCTAssertFalse(ConstantTime.equals("", "secret-a"))
        XCTAssertTrue(ConstantTime.equals("", ""))
    }

    func testAppTokensCarryUniqueJTIPerIssue() async throws {
        // MOMO-300 review fix: iat/exp are second-granular, so identical
        // claims within the same second used to produce byte-identical JWTs
        // (and identical token_hash rows — a revoked row then killed a fresh
        // login). The random jti must make every issue unique.
        let workspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let memberID = UUID(uuidString: "00000000-0000-7000-8000-000000000101")!
        let jwt = await JWTService(config: testServerConfig())

        let first = try await jwt.signAccess(
            memberID: memberID, workspaceID: workspaceID, scopes: ["messages:read"])
        let second = try await jwt.signAccess(
            memberID: memberID, workspaceID: workspaceID, scopes: ["messages:read"])

        XCTAssertNotEqual(first.token, second.token,
                          "same-second same-claim tokens must differ (jti)")

        let firstPayload = try await jwt.verify(first.token)
        let secondPayload = try await jwt.verify(second.token)
        XCTAssertFalse(firstPayload.jti.value.isEmpty)
        XCTAssertNotEqual(firstPayload.jti.value, secondPayload.jti.value)
        XCTAssertNotNil(UUID(uuidString: firstPayload.jti.value))

        // refresh tokens carry jti too (rotation path).
        let refresh = try await jwt.signRefresh(
            memberID: memberID, workspaceID: workspaceID, scopes: ["messages:read"])
        let refreshPayload = try await jwt.verify(refresh.token)
        XCTAssertNotNil(UUID(uuidString: refreshPayload.jti.value))
        XCTAssertNotEqual(refreshPayload.jti.value, firstPayload.jti.value)
    }

    func testSecurityBootValidationFailsFastOnPlaceholderProxySecretInStrictEnv() {
        var config = testServerConfig()

        // local env: placeholder allowed.
        config.momoEnvironment = "local"
        config.centProxySecret = "dev-insecure-cent-proxy-secret"
        XCTAssertNoThrow(try config.validateSecurityForBoot())

        // strict envs: placeholder/missing must fail fast.
        for env in ["staging", "prod", "production", "internal-host"] {
            config.momoEnvironment = env
            config.centProxySecret = "dev-insecure-cent-proxy-secret"
            XCTAssertThrowsError(try config.validateSecurityForBoot(), env)
            config.centProxySecret = "change-me-cent-proxy-secret"
            XCTAssertThrowsError(try config.validateSecurityForBoot(), env)
            config.centProxySecret = ""
            XCTAssertThrowsError(try config.validateSecurityForBoot(), env)
            config.centProxySecret = "0f3f2c9a51e64b4bb1d2f8f4f5a6b7c8"
            XCTAssertNoThrow(try config.validateSecurityForBoot(), env)
        }
    }

    func testSecurityBootValidationRejectsOutboundWebhookJWTKeyReuseInStrictEnv() {
        var config = testServerConfig()
        config.momoEnvironment = "prod"
        config.centProxySecret = "0f3f2c9a51e64b4bb1d2f8f4f5a6b7c8"
        config.outboundWebhookMasterKey = config.jwtHMAC
        XCTAssertThrowsError(try config.validateSecurityForBoot()) { error in
            XCTAssertTrue(String(describing: error).contains(
                "OUTBOUND_WEBHOOK_MASTER_KEY must not reuse JWT_HMAC"
            ))
        }
    }

    func testRateLimitConfigLoadsEnvAndClampsBadValues() {
        let defaults = RateLimitConfig.load(environment: [:])
        XCTAssertEqual(defaults.windowSeconds, 60)
        XCTAssertEqual(defaults.perMemberLimit, 600)
        XCTAssertEqual(defaults.perIPLimit, 1200)

        let custom = RateLimitConfig.load(environment: [
            "RATE_LIMIT_WINDOW_SECONDS": "10",
            "RATE_LIMIT_PER_MEMBER": "5",
            "RATE_LIMIT_PER_IP": "0",
        ])
        XCTAssertEqual(custom.windowSeconds, 10)
        XCTAssertEqual(custom.perMemberLimit, 5)
        XCTAssertEqual(custom.perIPLimit, 0) // 0 disables the axis

        let clamped = RateLimitConfig.load(environment: [
            "RATE_LIMIT_WINDOW_SECONDS": "0",
            "RATE_LIMIT_PER_MEMBER": "-3",
        ])
        XCTAssertEqual(clamped.windowSeconds, 1)
        XCTAssertEqual(clamped.perMemberLimit, 0)
    }

    func testSlidingWindowRateLimiterEnforcesWindowAndAuditsOnce() async {
        let limiter = SlidingWindowRateLimiter()
        let start = Date(timeIntervalSince1970: 1_000_000)

        // Limit 3 per 10s: first three pass, fourth is limited.
        for i in 0..<3 {
            let verdict = await limiter.check(
                key: "member:a", limit: 3, windowSeconds: 10,
                now: start.addingTimeInterval(Double(i)))
            XCTAssertTrue(verdict.allowed, "request \(i) should pass")
        }
        let limited = await limiter.check(
            key: "member:a", limit: 3, windowSeconds: 10,
            now: start.addingTimeInterval(3))
        XCTAssertFalse(limited.allowed)
        XCTAssertTrue(limited.shouldAudit, "first rejection audits")
        XCTAssertGreaterThanOrEqual(limited.retryAfterSeconds, 1)

        // Second rejection in the same burst must NOT audit again.
        let limitedAgain = await limiter.check(
            key: "member:a", limit: 3, windowSeconds: 10,
            now: start.addingTimeInterval(4))
        XCTAssertFalse(limitedAgain.allowed)
        XCTAssertFalse(limitedAgain.shouldAudit)

        // Keys are independent.
        let other = await limiter.check(
            key: "ip:203.0.113.7", limit: 3, windowSeconds: 10,
            now: start.addingTimeInterval(4))
        XCTAssertTrue(other.allowed)

        // After the window slides past the burst, requests pass again.
        let afterWindow = await limiter.check(
            key: "member:a", limit: 3, windowSeconds: 10,
            now: start.addingTimeInterval(20))
        XCTAssertTrue(afterWindow.allowed)

        // limit 0 = disabled axis.
        let disabled = await limiter.check(
            key: "member:a", limit: 0, windowSeconds: 10, now: start)
        XCTAssertTrue(disabled.allowed)
    }

    func testRateLimit429ResponseCarriesRetryAfter() {
        let response = RateLimitSupport.tooManyRequests(retryAfterSeconds: 7)
        XCTAssertEqual(response.status, .tooManyRequests)
        XCTAssertEqual(response.headers[RateLimitSupport.retryAfter], "7")
        XCTAssertEqual(response.headers[.contentType], "application/json")
    }

    // MARK: - MOMO-412 signed webhook ingress (ADR-0115)

    func testWebhookCryptoUsesOpaqueReferencesAndDeterministicIdempotency() throws {
        let workspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let installationID = UUID(uuidString: "41200000-0000-7000-8000-000000000001")!
        let reference = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        let secret = WebhookCrypto.nativeSecret(masterKey: "master", secretRef: reference)

        XCTAssertTrue(secret.hasPrefix("momo_whsec_v1."))
        XCTAssertFalse(secret.contains(reference))
        XCTAssertEqual(secret, WebhookCrypto.nativeSecret(masterKey: "master", secretRef: reference))
        XCTAssertNotEqual(secret, WebhookCrypto.nativeSecret(masterKey: "other", secretRef: reference))

        let token = "momo_hook_v1.\(workspaceID.uuidString.lowercased()).\(reference)"
        XCTAssertEqual(WebhookCrypto.workspaceID(fromSlackToken: token), workspaceID)
        XCTAssertNil(WebhookCrypto.workspaceID(fromSlackToken: "not-a-hook"))
        XCTAssertEqual(WebhookCrypto.tokenHash(token).count, "sha256:".count + 64)

        let first = WebhookCrypto.deterministicClientMessageID([
            workspaceID.uuidString, installationID.uuidString, "delivery-1",
        ])
        let retry = WebhookCrypto.deterministicClientMessageID([
            workspaceID.uuidString, installationID.uuidString, "delivery-1",
        ])
        let other = WebhookCrypto.deterministicClientMessageID([
            workspaceID.uuidString, installationID.uuidString, "delivery-2",
        ])
        XCTAssertEqual(first, retry)
        XCTAssertNotEqual(first, other)
    }

    func testWebhookCanonicalSignatureBaseBindsEveryADR0115Component() {
        let workspaceID = UUID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let installationID = UUID(uuidString: "41200000-0000-7000-8000-000000000001")!
        let base = WebhookCrypto.canonicalSignatureBase(
            workspaceID: workspaceID,
            installationID: installationID,
            timestamp: "1784260000",
            deliveryID: "delivery-1",
            bodySHA256: String(repeating: "a", count: 64)
        )

        XCTAssertEqual(
            base,
            "v1\nPOST\n/v1/webhooks/00000000-0000-7000-8000-000000000001/41200000-0000-7000-8000-000000000001\n41200000-0000-7000-8000-000000000001\n1784260000\ndelivery-1\n\(String(repeating: "a", count: 64))"
        )
        let signature = WebhookCrypto.signature(secret: "secret", base: base)
        XCTAssertEqual(signature.count, 64)
        XCTAssertEqual(signature, WebhookCrypto.signature(secret: "secret", base: base))
    }

    func testSlackCompatibleFixtureTranslatesMattermostSubset() throws {
        let data = Data(#"""
        {
          "text":"Build <https://ci.example/run/7|passed> <!channel> <@U123>",
          "attachments":[{
            "fallback":"deploy result",
            "color":"#36a64f",
            "pretext":"Production deploy",
            "author_name":"CI Bot",
            "author_link":"https://ci.example/",
            "author_icon":"https://ci.example/icon.png",
            "title":"Release 7",
            "title_link":"https://ci.example/run/7",
            "text":"Completed <https://ci.example/log|logs>",
            "fields":[{"title":"Status","value":"green","short":true}],
            "image_url":"https://ci.example/result.png",
            "thumb_url":"https://ci.example/thumb.png",
            "footer":"Jenkins",
            "footer_icon":"https://ci.example/footer.png"
          }]
        }
        """#.utf8)

        let rendered = try WebhookPayload.slackCompatible(data: data)
        XCTAssertEqual(rendered.clientProps, ["slack_compatible": "true"])
        XCTAssertEqual(
            rendered.body,
            "Build [passed](https://ci.example/run/7) @channel @U123\n\nProduction deploy\n[CI Bot](https://ci.example/)\n[Release 7](https://ci.example/run/7)\nCompleted [logs](https://ci.example/log)\nStatus: green\nhttps://ci.example/result.png\nhttps://ci.example/thumb.png\nJenkins"
        )
    }

    func testSlackCompatibleRejectsOnlyBlocks() throws {
        // Review #443 H1: blocks stays a hard 400 (v0 unsupported)...
        XCTAssertThrowsError(try WebhookPayload.slackCompatible(data: Data(#"{"text":"x","blocks":[]}"#.utf8))) { error in
            XCTAssertEqual((error as? HTTPError)?.status, .badRequest)
            XCTAssertTrue(String(describing: error).contains("blocks"))
        }
        // ...but Mattermost-unsupported fields are IGNORED, not rejected, so
        // real tools (Grafana/Alertmanager) work by swapping only the URL.
        XCTAssertEqual(
            try WebhookPayload.slackCompatible(data: Data(#"{"text":"x","mrkdwn":true,"username":"grafana","icon_emoji":":fire:"}"#.utf8)).body,
            "x")
        // identity overrides are dropped → author stays non-spoofable.
        XCTAssertEqual(
            try WebhookPayload.slackCompatible(data: Data(#"{"attachments":[{"text":"deploy ok","ts":1,"mrkdwn_in":["text"]}]}"#.utf8)).body,
            "deploy ok")
        // *bold* renders literally; broadcast mentions render as plain text.
        XCTAssertEqual(try WebhookPayload.slackCompatible(data: Data(#"{"text":"*Alerting* <!everyone>"}"#.utf8)).body, "*Alerting* @everyone")
    }

    func testNativeWebhookPayloadIsStrictAndBounded() throws {
        let rendered = try WebhookPayload.native(data: Data(#"{"text":"deploy complete","event_type":"deploy","metadata":{"region":"ap-northeast-2"}}"#.utf8))
        XCTAssertEqual(rendered.body, "deploy complete")
        XCTAssertEqual(rendered.clientProps["event_type"], "deploy")
        XCTAssertEqual(rendered.clientProps["metadata.region"], "ap-northeast-2")

        XCTAssertThrowsError(try WebhookPayload.native(data: Data(#"{"text":"x","secret":"must-not-pass"}"#.utf8)))
        XCTAssertThrowsError(try WebhookPayload.native(data: Data(#"{"text":""}"#.utf8)))
    }

    func testSlackURLSecretIsRedactedFromRequestLogging() {
        let token = "momo_hook_v1.00000000-0000-7000-8000-000000000001.raw-secret"
        XCTAssertEqual(
            SecretRedactingRequestLogMiddleware<AppRequestContext>.redactedPath("/hooks/\(token)"),
            "/hooks/[REDACTED]"
        )
        XCTAssertEqual(
            SecretRedactingRequestLogMiddleware<AppRequestContext>.redactedPath("/health"),
            "/health"
        )
        let rateLimitSourcePath = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/MomoServer/Middleware/RateLimitMiddleware.swift")
        let rateLimitSource = try? String(contentsOf: rateLimitSourcePath, encoding: .utf8)
        XCTAssertTrue(rateLimitSource?.contains(".redactedPath(path)") == true)
    }

    func testWebhookRouteKeepsReceiptMessageAndOutboxInOneTenantTransaction() throws {
        let testFile = URL(fileURLWithPath: #filePath)
        let serverRoot = testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let source = try String(
            contentsOf: serverRoot.appendingPathComponent("Sources/MomoServer/Routes/WebhookRoutes.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(source.contains("withTenantTransactionUnwrapped"))
        XCTAssertTrue(source.contains("INSERT INTO webhook_receipt"))
        XCTAssertTrue(source.contains("UPDATE channel_seq"))
        XCTAssertTrue(source.contains("INSERT INTO message"))
        XCTAssertTrue(source.contains("INSERT INTO outbox"))
        XCTAssertTrue(source.contains("deterministicClientMessageID"))
        XCTAssertFalse(source.contains("CentrifugoClient"))
        XCTAssertFalse(source.contains("/api/publish"))
        XCTAssertFalse(source.contains("withPlatformReadConnection"))
        XCTAssertFalse(source.contains("BYPASSRLS"))
    }

    private func testServerConfig(
        accessTokenTTL: TimeInterval = 15 * 60,
        centConnectionTokenTTL: TimeInterval = 5 * 60
    ) -> Config {
        Config(
            host: "127.0.0.1",
            port: 8080,
            pgHost: "localhost",
            pgPort: 5432,
            pgUser: "momo",
            pgPassword: "momo",
            pgDatabase: "momo",
            jwtHMAC: "test-jwt-hmac",
            outboundWebhookMasterKey: "test-outbound-webhook-master-key",
            providerLinkMasterKey: "test-provider-link-master-key",
            accessTokenTTL: accessTokenTTL,
            refreshTokenTTL: 30 * 24 * 60 * 60,
            centAPIURL: "http://localhost:8000/api",
            centAPIKey: "test-cent-api-key",
            realtimeWebSocketURL: "ws://127.0.0.1:8000/connection/websocket",
            centTokenHMAC: "test-cent-token-hmac",
            centConnectionTokenTTL: centConnectionTokenTTL,
            centProxySecret: "test-cent-proxy-secret",
            liveKit: nil,
            rateLimit: RateLimitConfig(windowSeconds: 60, perMemberLimit: 600, perIPLimit: 1200),
            platformAdminDatabaseURL: nil,
            platformAdminEmails: [],
            platformAdminLoginSecret: nil,
            momoEnvironment: "local",
            agentProvider: AgentProviderConfig(
                mode: .localMock,
                hermesBaseURL: "http://localhost:8088/v1",
                hermesAPIKey: "dev-insecure-hermes-bearer",
                model: "hermes-agent",
                agentHandle: "kim-intern",
                displayName: "김인턴",
                allowLocalLoopback: false
            ),
            agentGateway: AgentGatewayConfig(mode: .worker, secret: ""),
            cloudProvisioner: CloudProvisionerConfig.load(environment: [:])
        )
    }

    // MARK: - MOMO-403 device/push_token registration (ADR-0120 P-1)

    func testDeviceRegistrationPlatformAndEnvValidation() throws {
        XCTAssertEqual(try DeviceRoutes.normalizedPlatform(" iOS "), "ios")
        XCTAssertEqual(try DeviceRoutes.normalizedPlatform("MACOS"), "macos")
        XCTAssertThrowsError(try DeviceRoutes.normalizedPlatform("android"))
        XCTAssertThrowsError(try DeviceRoutes.normalizedPlatform(""))

        XCTAssertEqual(try DeviceRoutes.normalizedEnv("Sandbox"), "sandbox")
        XCTAssertEqual(try DeviceRoutes.normalizedEnv(" production "), "production")
        XCTAssertThrowsError(try DeviceRoutes.normalizedEnv("prod"))
        XCTAssertThrowsError(try DeviceRoutes.normalizedEnv(""))
    }

    func testDeviceRegistrationApnsTokenNormalization() throws {
        let hex64 = String(repeating: "AB12cd34", count: 8)
        XCTAssertEqual(try DeviceRoutes.normalizedApnsToken(" \(hex64) "), hex64.lowercased())
        // Case-stable normalization keeps UNIQUE (apns_token, env) arbitration exact.
        XCTAssertEqual(
            try DeviceRoutes.normalizedApnsToken(hex64.uppercased()),
            try DeviceRoutes.normalizedApnsToken(hex64.lowercased())
        )
        XCTAssertThrowsError(try DeviceRoutes.normalizedApnsToken("not-hex-token!"))
        XCTAssertThrowsError(try DeviceRoutes.normalizedApnsToken("abcdef"))          // too short
        XCTAssertThrowsError(try DeviceRoutes.normalizedApnsToken(String(repeating: "a", count: 513)))
        XCTAssertThrowsError(try DeviceRoutes.normalizedApnsToken(""))
    }

    func testDeviceRegistrationTopicAndAppBuildValidation() throws {
        XCTAssertEqual(try DeviceRoutes.normalizedTopic(" kim.dawn.momo "), "kim.dawn.momo")
        XCTAssertThrowsError(try DeviceRoutes.normalizedTopic(""))
        XCTAssertThrowsError(try DeviceRoutes.normalizedTopic("has space.bundle"))
        XCTAssertThrowsError(try DeviceRoutes.normalizedTopic("ctrl\u{0007}bundle"))
        XCTAssertThrowsError(try DeviceRoutes.normalizedTopic(String(repeating: "a", count: 257)))

        XCTAssertNil(try DeviceRoutes.validatedAppBuild(nil))
        XCTAssertNil(try DeviceRoutes.validatedAppBuild("   "))
        XCTAssertEqual(try DeviceRoutes.validatedAppBuild(" 1.0.0+42 "), "1.0.0+42")
        XCTAssertThrowsError(try DeviceRoutes.validatedAppBuild(String(repeating: "b", count: 65)))
    }

    func testDeviceRegistrationDeviceIDValidation() throws {
        let id = UUID()
        XCTAssertEqual(try DeviceRoutes.validatedDeviceID(" \(id.uuidString) "), id)
        XCTAssertEqual(try DeviceRoutes.validatedDeviceID(id.uuidString.lowercased()), id)
        XCTAssertThrowsError(try DeviceRoutes.validatedDeviceID("not-a-uuid"))
        XCTAssertThrowsError(try DeviceRoutes.validatedDeviceID(""))
    }

    func testDeviceRoutesNeverReturnRawApnsToken() {
        // The wire receipt is suffix/ref only (MOMO-403 hard contract): the
        // shared SELECT fragment must render `right(apns_token, 8)` and never
        // project the raw column into the response JSON.
        XCTAssertTrue(DeviceRoutes.deviceJSONSelect.contains("right(t.apns_token, 8)"))
        XCTAssertFalse(DeviceRoutes.deviceJSONSelect.contains("'apnsToken', t.apns_token"))
        XCTAssertFalse(DeviceRoutes.deviceJSONSelect.contains("'apns_token', t.apns_token"))

        // And the DTO shape itself has no full-token field.
        let mirror = Mirror(reflecting: PushTokenDTO(
            id: "", deviceId: "", env: "sandbox", topic: "t",
            apnsTokenSuffix: "s", invalidatedAtMs: nil, createdAtMs: 0, updatedAtMs: 0
        ))
        XCTAssertFalse(mirror.children.contains { $0.label == "apnsToken" })
    }

    func testPushRegistrationMigrationStaticContract() throws {
        // 010: one ACTIVE token per (device, env) partial unique index +
        // device_id lookup index; rows are invalidated, never deleted, so no
        // DROP/DELETE may appear (dispatch_log FK preservation, ADR-0120 D4).
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let migration = try String(
            contentsOf: serverRoot.appendingPathComponent("Migrations/010_push_registration.sql"),
            encoding: .utf8
        )
        XCTAssertTrue(migration.contains("CREATE UNIQUE INDEX push_token_device_env_active_uniq"))
        XCTAssertTrue(migration.contains("ON push_token (device_id, env)"))
        XCTAssertTrue(migration.contains("WHERE invalidated_at IS NULL"))
        XCTAssertTrue(migration.contains("CREATE INDEX push_token_device_idx"))
        XCTAssertFalse(migration.lowercased().contains("drop table"))
        XCTAssertFalse(migration.lowercased().contains("delete from"))
        XCTAssertFalse(migration.lowercased().contains("alter table device"))
        XCTAssertFalse(migration.lowercased().contains("alter table push_token"))
    }

    // MARK: - MOMO-468 huddles (ADR-0122 V-1)

    func testLiveKitConfigurationIsAllOrNothing() {
        XCTAssertNil(LiveKitConfig.load(environment: [:]))
        XCTAssertNil(LiveKitConfig.load(environment: [
            "MOMO_LIVEKIT_API_KEY": "key",
            "MOMO_LIVEKIT_API_SECRET": "secret",
        ]))
        XCTAssertNil(LiveKitConfig.load(environment: [
            "MOMO_LIVEKIT_API_KEY": "key",
            "MOMO_LIVEKIT_API_SECRET": "secret",
            "MOMO_LIVEKIT_URL": "file:///tmp/livekit",
        ]))
        XCTAssertEqual(LiveKitConfig.load(environment: [
            "MOMO_LIVEKIT_API_KEY": "key",
            "MOMO_LIVEKIT_API_SECRET": "secret",
            "MOMO_LIVEKIT_URL": "wss://livekit.momo.test",
        ]), LiveKitConfig(apiKey: "key", apiSecret: "secret", url: "wss://livekit.momo.test"))
    }

    func testLiveKitJWTClaimsAndSignatureArePure() throws {
        let config = LiveKitConfig(
            apiKey: "livekit-api-key",
            apiSecret: "livekit-api-secret",
            url: "wss://livekit.momo.test"
        )
        let roomID = UUID(uuidString: "48600000-0000-7000-8000-000000000001")!
        let memberID = UUID(uuidString: "48600000-0000-7000-8000-000000000002")!
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let first = try LiveKitTokenService.issue(
            config: config, roomID: roomID, memberID: memberID,
            displayName: "Huddle Member", now: now
        )
        let retry = try LiveKitTokenService.issue(
            config: config, roomID: roomID, memberID: memberID,
            displayName: "Huddle Member", now: now
        )

        XCTAssertEqual(first.token, retry.token)
        XCTAssertEqual(first.claims.iss, config.apiKey)
        XCTAssertEqual(first.claims.sub, memberID.uuidString)
        XCTAssertEqual(first.claims.name, "Huddle Member")
        XCTAssertEqual(first.claims.nbf, 1_800_000_000)
        XCTAssertEqual(first.claims.exp - first.claims.nbf, 600)
        XCTAssertEqual(first.claims.video.room, roomID.uuidString)
        XCTAssertTrue(first.claims.video.roomJoin)
        XCTAssertTrue(first.claims.video.canPublish)
        XCTAssertTrue(first.claims.video.canSubscribe)
        XCTAssertTrue(LiveKitTokenService.hasValidSignature(first.token, secret: config.apiSecret))
        XCTAssertFalse(LiveKitTokenService.hasValidSignature(first.token, secret: "wrong-secret"))
        XCTAssertFalse(first.token.contains(config.apiSecret))
    }

    func testHuddleLeaveLifecycleTransitionIsPure() {
        let participantsRemain = HuddleLifecycle.eventAfterLeave(activeParticipantCount: 1)
        XCTAssertFalse(participantsRemain.ended)
        XCTAssertEqual(participantsRemain.type, "huddle_participants_changed")

        let lastParticipantLeft = HuddleLifecycle.eventAfterLeave(activeParticipantCount: 0)
        XCTAssertTrue(lastParticipantLeft.ended)
        XCTAssertEqual(lastParticipantLeft.type, "huddle_ended")
    }

    func testHuddleRecordingConsentGateFailsClosed() {
        XCTAssertFalse(
            HuddleRecordingConsentGate.allowsRecording(
                activeParticipantCount: 0, consentedParticipantCount: 0
            )
        )
        XCTAssertFalse(
            HuddleRecordingConsentGate.allowsRecording(
                activeParticipantCount: 2, consentedParticipantCount: 1
            )
        )
        XCTAssertTrue(
            HuddleRecordingConsentGate.allowsRecording(
                activeParticipantCount: 2, consentedParticipantCount: 2
            )
        )
        XCTAssertNil(HuddleRoutes.validatedTranscriptionModel(nil))
        XCTAssertNil(HuddleRoutes.validatedTranscriptionModel("  "))
        XCTAssertEqual(
            HuddleRoutes.validatedTranscriptionModel(" faster-whisper-small "),
            "faster-whisper-small"
        )
    }

    func testHuddleMigrationAndRouteStaticContracts() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let migration = try String(
            contentsOf: serverRoot.appendingPathComponent("Migrations/016_huddle.sql"),
            encoding: .utf8
        )
        XCTAssertTrue(migration.contains("CREATE TABLE huddle"))
        XCTAssertTrue(migration.contains("CREATE TABLE huddle_participant"))
        XCTAssertTrue(migration.contains("WHERE ended_at IS NULL"))
        XCTAssertTrue(migration.contains("WHERE left_at IS NULL"))
        XCTAssertTrue(migration.contains("FORCE ROW LEVEL SECURITY"))

        let routes = try String(
            contentsOf: serverRoot.appendingPathComponent("Sources/MomoServer/Routes/HuddleRoutes.swift"),
            encoding: .utf8
        )
        XCTAssertTrue(routes.contains("withTenantTransactionUnwrapped"))
        XCTAssertTrue(routes.contains("INSERT INTO outbox"))
        XCTAssertTrue(routes.contains("INSERT INTO audit_log"))
        XCTAssertFalse(routes.contains("CentrifugoClient"))
        XCTAssertFalse(routes.contains("/api/publish"))
        XCTAssertFalse(routes.contains("apiSecret"))
    }

    func testHuddleTranscriptionMigrationAndRouteStaticContracts() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let migration = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Migrations/046_huddle_transcription.sql"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(migration.contains("CREATE TABLE huddle_recording_consent"))
        XCTAssertTrue(migration.contains("CREATE TABLE huddle_transcription_job"))
        XCTAssertTrue(migration.contains("REFERENCES attachment(workspace_id, id)"))
        XCTAssertTrue(migration.contains("WHERE status = 'queued'"))
        XCTAssertTrue(migration.contains("FORCE ROW LEVEL SECURITY"))
        XCTAssertFalse(migration.contains("audio_path"))
        XCTAssertFalse(migration.contains("transcript_path"))

        let routes = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Routes/HuddleRoutes.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(routes.contains("recording-consent"))
        XCTAssertTrue(routes.contains("explicit consent from every active participant"))
        XCTAssertTrue(routes.contains("insertRecordingNotice"))
        XCTAssertTrue(routes.contains("enqueueTranscriptionIfRecordingEnded"))
        XCTAssertTrue(routes.contains("MessageRoutes.broadcastPayload"))
        XCTAssertFalse(routes.lowercased().contains("diarization"))
    }

    func testWorkspaceSearchCursorRoundTripAndLiteralLikePattern() throws {
        let cursor = SearchRoutes.Cursor(
            createdAtMicros: 1_900_000_123_456_789,
            seq: 42,
            messageID: UUID(uuidString: "50000000-0000-7000-8000-000000000001")!
        )
        let encoded = SearchRoutes.encodeCursor(cursor)
        XCTAssertFalse(encoded.contains("="))
        XCTAssertEqual(try SearchRoutes.decodeCursor(encoded), cursor)
        XCTAssertEqual(SearchRoutes.literalLikePattern(#"50%_\완료"#), #"%50\%\_\\완료%"#)
    }

    func testWorkspaceSearchQueryValidationAndAgentScope() throws {
        XCTAssertThrowsError(try SearchRoutes.normalizedQuery(" 한 "))
        XCTAssertEqual(try SearchRoutes.normalizedQuery("  한글 search  "), "한글 search")
        XCTAssertThrowsError(try SearchRoutes.decodeCursor("not-a-cursor"))
        XCTAssertEqual(
            AuthMiddleware.requiredAgentScope(
                method: "GET",
                path: "/v1/workspaces/50000000-0000-7000-8000-000000000001/search/messages"
            ),
            "messages:read"
        )
    }

    func testWorkspaceRoleValidationAndHierarchyRanks() throws {
        XCTAssertEqual(try WorkspaceRole.parse(" OWNER "), .owner)
        XCTAssertEqual(try WorkspaceRole.parse("guest"), .guest)
        XCTAssertLessThan(WorkspaceRole.owner.rank, WorkspaceRole.admin.rank)
        XCTAssertLessThan(WorkspaceRole.admin.rank, WorkspaceRole.member.rank)
        XCTAssertThrowsError(try WorkspaceRole.parse("platform_admin"))
    }

    func testMembershipLifecycleMigrationAndRoutesStaticContracts() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let migration = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Migrations/026_workspace_membership_lifecycle.sql"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(migration.contains("CREATE TABLE IF NOT EXISTS workspace_membership"))
        XCTAssertTrue(migration.contains("CREATE TABLE IF NOT EXISTS workspace_ban"))
        XCTAssertTrue(migration.contains("ON CONFLICT (workspace_id, member_id) DO NOTHING"))
        XCTAssertTrue(migration.contains("FORCE ROW LEVEL SECURITY"))
        XCTAssertTrue(migration.contains("CREATE POLICY ws_isolation"))

        let routes = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Routes/MemberLifecycleRoutes.swift"
            ),
            encoding: .utf8
        )
        for path in ["/role", "/suspend", "/reinstate", "/bans"] {
            XCTAssertTrue(routes.contains(path))
        }
        for action in [
            "role.changed", "member.suspended", "member.reinstated",
            "member.removed", "ban.created", "ban.deleted",
        ] {
            XCTAssertTrue(routes.contains(action))
        }
        XCTAssertTrue(routes.contains("workspace must retain at least one owner"))
        XCTAssertTrue(routes.contains("UPDATE token SET revoked_at"))
        XCTAssertTrue(routes.contains("DELETE FROM membership"))
        XCTAssertFalse(routes.contains("BYPASSRLS"))
    }

    func testWorkspaceAuthorizationIsCentralizedOnWorkspaceMembership() throws {
        let serverRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let authorization = try String(
            contentsOf: serverRoot.appendingPathComponent(
                "Sources/MomoServer/Auth/WorkspaceAuthorization.swift"
            ),
            encoding: .utf8
        )
        XCTAssertTrue(authorization.contains("FROM workspace_membership wm"))
        XCTAssertFalse(authorization.contains("FROM membership ms"))
        XCTAssertTrue(authorization.contains("m.status = 'active'"))
        XCTAssertTrue(authorization.contains("pg_advisory_xact_lock"))
    }
}
