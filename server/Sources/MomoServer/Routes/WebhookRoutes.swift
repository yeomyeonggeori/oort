import Foundation
import HTTPTypes
import Hummingbird
import Logging
import NIOCore
import PostgresNIO

/// ADR-0115 signed native and Slack-compatible incoming webhook surface.
///
/// Successful ingress has exactly one commit boundary: receipt, deterministic
/// client_msg_id, channel seq, message, and outbox. This route never owns a
/// Centrifugo client and therefore cannot publish around the outbox relay.
struct WebhookRoutes: Sendable {
    static let pluginID = "external_webhook"
    static let signatureVersionHeader = HTTPField.Name("X-Momo-Signature-Version")!
    static let keyIDHeader = HTTPField.Name("X-Momo-Key-Id")!
    static let timestampHeader = HTTPField.Name("X-Momo-Timestamp")!
    static let deliveryIDHeader = HTTPField.Name("X-Momo-Delivery-Id")!
    static let signatureHeader = HTTPField.Name("X-Momo-Signature")!
    static let replayWindowSeconds: TimeInterval = 5 * 60
    static let slackDedupeWindowSeconds: TimeInterval = 5 * 60
    static let maximumRotationOverlapSeconds = 7 * 24 * 60 * 60

    let db: Database
    /// Existing server secret with an explicit webhook KDF domain separator.
    /// Only a derived secret is one-time revealed; this master never enters DB.
    let signingMasterKey: String

    func addPublic(to router: Router<AppRequestContext>) {
        router.post("/v1/webhooks/:ws/:installation", use: receiveNative)
        router.post("/hooks/:token", use: receiveSlackCompatible)
    }

    func addProtected(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/workspaces/:ws/webhooks", use: list)
        group.post("/v1/workspaces/:ws/webhooks", use: create)
        group.post("/v1/workspaces/:ws/webhooks/:installation/rotate", use: rotate)
        group.delete("/v1/workspaces/:ws/webhooks/:installation", use: revoke)
    }

    // MARK: - Management

    @Sendable
    func list(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.humanPrincipal(context)
        let workspaceID = try Self.workspaceID(context, principal: principal)
        // HTTPError from the closure must retain 403/404 semantics rather than
        // being wrapped as PostgresTransactionError and rendered as 500.
        let installations = try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
            _ = try await Self.requireWorkspaceAdmin(
                conn: conn, logger: db.logger, principal: principal
            )
            let rows = try await conn.query(
                """
                SELECT id, channel_id, author_member_id, mode, label,
                       revoked_at, created_at, updated_at
                  FROM webhook_installation
                 WHERE workspace_id = \(workspaceID)
                 ORDER BY created_at DESC
                 LIMIT 200
                """,
                logger: db.logger
            ).collect()
            return try rows.map(Self.decodeInstallation)
        }
        return try WebhookInstallationListResponse(installations: installations)
            .response(from: request, context: context)
    }

    @Sendable
    func create(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.humanPrincipal(context)
        let workspaceID = try Self.workspaceID(context, principal: principal)
        let body = try await request.decode(as: CreateWebhookRequest.self, context: context)
        let channelID = try Self.requiredUUID(body.channelId, label: "channelId")
        let mode = try Self.normalizedMode(body.mode)
        let label = try Self.normalizedLabel(body.label)

        let installationID = UUID()
        let authorMemberID = UUID()
        let keyID = UUID()
        let pluginAuditID = UUID()
        let webhookAuditID = UUID()
        let authorHandle = "webhook-\(installationID.uuidString.lowercased().replacingOccurrences(of: "-", with: ""))"
        let secretRef: String?
        let rawSlackToken: String?
        let tokenHash: String?
        switch mode {
        case .native:
            secretRef = WebhookCrypto.randomReference()
            rawSlackToken = nil
            tokenHash = nil
        case .slackCompatible:
            let token = WebhookCrypto.slackToken(workspaceID: workspaceID)
            secretRef = nil
            rawSlackToken = token
            tokenHash = WebhookCrypto.tokenHash(token)
        }

        let installation = try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
            _ = try await Self.requireWorkspaceAdmin(
                conn: conn, logger: db.logger, principal: principal
            )
            let channelRows = try await conn.query(
                """
                SELECT 1 FROM channel
                 WHERE id = \(channelID)
                   AND workspace_id = \(workspaceID)
                   AND archived_at IS NULL
                """,
                logger: db.logger
            ).collect()
            guard !channelRows.isEmpty else {
                throw HTTPError(.notFound, message: "active channel not found")
            }

            try await Self.lockMutation(
                conn: conn,
                logger: db.logger,
                key: "external-webhook-install:\(workspaceID.uuidString)"
            )
            let existingPluginInstall = try await conn.query(
                """
                SELECT id FROM workspace_plugin_install
                 WHERE workspace_id = \(workspaceID)
                   AND plugin_id = \(Self.pluginID)
                 FOR UPDATE
                """,
                logger: db.logger
            ).collect().first
            let pluginInstallID = try existingPluginInstall?.decode(UUID.self) ?? UUID()

            try await Self.insertAudit(
                conn: conn,
                logger: db.logger,
                id: pluginAuditID,
                workspaceID: workspaceID,
                principal: principal,
                action: "plugin.installed",
                targetType: "plugin_install",
                targetID: pluginInstallID,
                detail: [
                    "schema": "momo.external_webhook.plugin_install.v1",
                    "plugin_id": Self.pluginID,
                ]
            )
            if existingPluginInstall == nil {
                _ = try await conn.query(
                    """
                    INSERT INTO workspace_plugin_install
                      (id, workspace_id, plugin_id, enabled, installed_by, installed_audit_id)
                    VALUES
                      (\(pluginInstallID), \(workspaceID), \(Self.pluginID), true,
                       \(principal.memberID), \(pluginAuditID))
                    """,
                    logger: db.logger
                )
            } else {
                _ = try await conn.query(
                    """
                    UPDATE workspace_plugin_install
                       SET enabled = true,
                           installed_by = \(principal.memberID),
                           installed_audit_id = \(pluginAuditID),
                           revoked_at = NULL,
                           revoked_by = NULL,
                           revoked_audit_id = NULL,
                           updated_at = now()
                     WHERE id = \(pluginInstallID)
                    """,
                    logger: db.logger
                )
            }

            // schema_v0 has only human/agent member kinds. A dedicated agent-kind
            // service member avoids installer impersonation, but receives no
            // agent row, credential, provider config, or execution capability.
            _ = try await conn.query(
                """
                INSERT INTO member
                  (id, workspace_id, kind, status, display_name, handle)
                VALUES
                  (\(authorMemberID), \(workspaceID), 'agent', 'active',
                   \(label), \(authorHandle))
                """,
                logger: db.logger
            )
            _ = try await conn.query(
                """
                INSERT INTO membership (workspace_id, channel_id, member_id, role)
                VALUES (\(workspaceID), \(channelID), \(authorMemberID), 'member')
                """,
                logger: db.logger
            )

            try await Self.insertAudit(
                conn: conn,
                logger: db.logger,
                id: webhookAuditID,
                workspaceID: workspaceID,
                principal: principal,
                action: "webhook.issued",
                targetType: "webhook_installation",
                targetID: installationID,
                detail: [
                    "schema": "momo.webhook.issued.v1",
                    "channel_id": channelID.uuidString,
                    "mode": mode.rawValue,
                    "key_id": keyID.uuidString,
                    "author_model": "dedicated_service_member",
                ]
            )
            _ = try await conn.query(
                """
                INSERT INTO webhook_installation
                  (id, workspace_id, channel_id, plugin_install_id,
                   author_member_id, mode, label, created_by, created_audit_id)
                VALUES
                  (\(installationID), \(workspaceID), \(channelID), \(pluginInstallID),
                   \(authorMemberID), \(mode.rawValue), \(label),
                   \(principal.memberID), \(webhookAuditID))
                """,
                logger: db.logger
            )
            _ = try await conn.query(
                """
                INSERT INTO webhook_secret_key
                  (id, workspace_id, installation_id, mode, secret_ref, token_hash,
                   created_by, created_audit_id)
                VALUES
                  (\(keyID), \(workspaceID), \(installationID), \(mode.rawValue),
                   \(secretRef), \(tokenHash), \(principal.memberID), \(webhookAuditID))
                """,
                logger: db.logger
            )
            return WebhookInstallationDTO(
                id: installationID,
                channelId: channelID,
                authorMemberId: authorMemberID,
                mode: mode.rawValue,
                label: label,
                status: "active",
                createdAtMs: Int64(Date().timeIntervalSince1970 * 1_000),
                updatedAtMs: Int64(Date().timeIntervalSince1970 * 1_000)
            )
        }

        let response = Self.secretResponse(
            installation: installation,
            workspaceID: workspaceID,
            keyID: keyID,
            mode: mode,
            secretRef: secretRef,
            slackToken: rawSlackToken,
            signingMasterKey: signingMasterKey,
            overlapSeconds: nil
        )
        var encoded = try response.response(from: request, context: context)
        encoded.status = .created
        Self.disableCaching(&encoded)
        return encoded
    }

    @Sendable
    func rotate(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.humanPrincipal(context)
        let workspaceID = try Self.workspaceID(context, principal: principal)
        let installationID = try Self.installationID(context)
        let body = try await request.decode(as: RotateWebhookRequest.self, context: context)
        let overlapSeconds = try Self.validatedOverlapSeconds(body.overlapSeconds)
        let overlapDeadline = Date().addingTimeInterval(TimeInterval(overlapSeconds))
        let keyID = UUID()
        let auditID = UUID()
        let newSecretRef = WebhookCrypto.randomReference()
        let newSlackToken = WebhookCrypto.slackToken(workspaceID: workspaceID)

        let installation = try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
            _ = try await Self.requireWorkspaceAdmin(
                conn: conn, logger: db.logger, principal: principal
            )
            let rows = try await conn.query(
                """
                SELECT id, channel_id, author_member_id, mode, label,
                       revoked_at, created_at, updated_at
                  FROM webhook_installation
                 WHERE id = \(installationID)
                   AND workspace_id = \(workspaceID)
                 FOR UPDATE
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.notFound, message: "webhook installation not found")
            }
            let installation = try Self.decodeInstallation(row)
            guard installation.status == "active",
                  let mode = WebhookMode(rawValue: installation.mode)
            else {
                throw HTTPError(.conflict, message: "webhook installation is revoked")
            }

            _ = try await conn.query(
                """
                UPDATE webhook_secret_key
                   SET valid_until = CASE
                         WHEN valid_until IS NULL OR valid_until > \(overlapDeadline)
                           THEN \(overlapDeadline)
                         ELSE valid_until
                       END
                 WHERE workspace_id = \(workspaceID)
                   AND installation_id = \(installationID)
                   AND revoked_at IS NULL
                   AND (valid_until IS NULL OR valid_until > now())
                """,
                logger: db.logger
            )
            try await Self.insertAudit(
                conn: conn,
                logger: db.logger,
                id: auditID,
                workspaceID: workspaceID,
                principal: principal,
                action: "webhook.rotated",
                targetType: "webhook_installation",
                targetID: installationID,
                detail: [
                    "schema": "momo.webhook.rotated.v1",
                    "mode": mode.rawValue,
                    "key_id": keyID.uuidString,
                    "overlap_seconds": overlapSeconds,
                ]
            )
            let secretRef: String? = mode == .native ? newSecretRef : nil
            let tokenHash: String? = mode == .slackCompatible
                ? WebhookCrypto.tokenHash(newSlackToken)
                : nil
            _ = try await conn.query(
                """
                INSERT INTO webhook_secret_key
                  (id, workspace_id, installation_id, mode, secret_ref, token_hash,
                   created_by, created_audit_id)
                VALUES
                  (\(keyID), \(workspaceID), \(installationID), \(mode.rawValue),
                   \(secretRef), \(tokenHash), \(principal.memberID), \(auditID))
                """,
                logger: db.logger
            )
            _ = try await conn.query(
                "UPDATE webhook_installation SET updated_at = now() WHERE id = \(installationID)",
                logger: db.logger
            )
            return installation
        }

        let mode = WebhookMode(rawValue: installation.mode)!
        let response = Self.secretResponse(
            installation: installation,
            workspaceID: workspaceID,
            keyID: keyID,
            mode: mode,
            secretRef: mode == .native ? newSecretRef : nil,
            slackToken: mode == .slackCompatible ? newSlackToken : nil,
            signingMasterKey: signingMasterKey,
            overlapSeconds: overlapSeconds
        )
        var encoded = try response.response(from: request, context: context)
        Self.disableCaching(&encoded)
        return encoded
    }

    @Sendable
    func revoke(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.humanPrincipal(context)
        let workspaceID = try Self.workspaceID(context, principal: principal)
        let installationID = try Self.installationID(context)
        let installation = try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
            _ = try await Self.requireWorkspaceAdmin(
                conn: conn, logger: db.logger, principal: principal
            )
            let rows = try await conn.query(
                """
                SELECT id, channel_id, author_member_id, mode, label,
                       revoked_at, created_at, updated_at
                  FROM webhook_installation
                 WHERE id = \(installationID)
                   AND workspace_id = \(workspaceID)
                 FOR UPDATE
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.notFound, message: "webhook installation not found")
            }
            var installation = try Self.decodeInstallation(row)
            if installation.status == "active" {
                let auditID = UUID()
                try await Self.insertAudit(
                    conn: conn,
                    logger: db.logger,
                    id: auditID,
                    workspaceID: workspaceID,
                    principal: principal,
                    action: "webhook.revoked",
                    targetType: "webhook_installation",
                    targetID: installationID,
                    detail: [
                        "schema": "momo.webhook.revoked.v1",
                        "mode": installation.mode,
                        "channel_id": installation.channelId.uuidString,
                    ]
                )
                _ = try await conn.query(
                    """
                    UPDATE webhook_installation
                       SET revoked_at = now(), revoked_by = \(principal.memberID),
                           revoked_audit_id = \(auditID), updated_at = now()
                     WHERE id = \(installationID)
                    """,
                    logger: db.logger
                )
                _ = try await conn.query(
                    """
                    UPDATE webhook_secret_key
                       SET revoked_at = COALESCE(revoked_at, now())
                     WHERE workspace_id = \(workspaceID)
                       AND installation_id = \(installationID)
                    """,
                    logger: db.logger
                )
                installation = WebhookInstallationDTO(
                    id: installation.id,
                    channelId: installation.channelId,
                    authorMemberId: installation.authorMemberId,
                    mode: installation.mode,
                    label: installation.label,
                    status: "revoked",
                    createdAtMs: installation.createdAtMs,
                    updatedAtMs: Int64(Date().timeIntervalSince1970 * 1_000)
                )
            }
            return installation
        }
        return try WebhookRevokeResponse(installation: installation, revoked: true)
            .response(from: request, context: context)
    }

    // MARK: - Public ingress

    @Sendable
    func receiveNative(_ originalRequest: Request, context: AppRequestContext) async throws -> Response {
        let workspaceID = try Self.pathUUID(context, name: "ws")
        let installationID = try Self.pathUUID(context, name: "installation")
        guard originalRequest.headers[Self.signatureVersionHeader] == "v1",
              let keyIDRaw = originalRequest.headers[Self.keyIDHeader],
              let keyID = UUID(uuidString: keyIDRaw),
              let timestampRaw = originalRequest.headers[Self.timestampHeader],
              let timestamp = Int64(timestampRaw),
              let deliveryID = originalRequest.headers[Self.deliveryIDHeader],
              deliveryID.wholeMatch(of: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/) != nil,
              let signatureRaw = originalRequest.headers[Self.signatureHeader]
        else {
            throw HTTPError(.unauthorized, message: "invalid webhook authentication")
        }
        let now = Date()
        guard abs(now.timeIntervalSince1970 - TimeInterval(timestamp)) <= Self.replayWindowSeconds else {
            throw HTTPError(.unauthorized, message: "webhook timestamp is outside the replay window")
        }
        let signature = signatureRaw.hasPrefix("v1=") ? String(signatureRaw.dropFirst(3)) : signatureRaw
        guard signature.wholeMatch(of: /^[0-9a-fA-F]{64}$/) != nil else {
            throw HTTPError(.unauthorized, message: "invalid webhook authentication")
        }
        let rawBody = try await Self.collectBody(originalRequest)
        let bodySHA256 = WebhookCrypto.sha256Hex(rawBody)
        let base = WebhookCrypto.canonicalSignatureBase(
            workspaceID: workspaceID,
            installationID: installationID,
            timestamp: timestampRaw,
            deliveryID: deliveryID,
            bodySHA256: bodySHA256
        )

        let result = try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
            let rows = try await conn.query(
                """
                SELECT wi.channel_id, wi.author_member_id, wi.label, wsk.secret_ref
                  FROM webhook_installation wi
                  JOIN webhook_secret_key wsk
                    ON wsk.workspace_id = wi.workspace_id
                   AND wsk.installation_id = wi.id
                 WHERE wi.id = \(installationID)
                   AND wi.workspace_id = \(workspaceID)
                   AND wi.mode = 'native'
                   AND wi.revoked_at IS NULL
                   AND wsk.id = \(keyID)
                   AND wsk.mode = 'native'
                   AND wsk.revoked_at IS NULL
                   AND wsk.valid_from <= now()
                   AND (wsk.valid_until IS NULL OR wsk.valid_until > now())
                 FOR SHARE OF wi, wsk
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.unauthorized, message: "invalid webhook authentication")
            }
            let (channelID, authorMemberID, label, secretRef) = try row.decode(
                (UUID, UUID, String, String).self
            )
            let secret = WebhookCrypto.nativeSecret(
                masterKey: signingMasterKey, secretRef: secretRef
            )
            let expected = WebhookCrypto.signature(secret: secret, base: base)
            guard ConstantTime.equals(signature.lowercased(), expected) else {
                throw HTTPError(.unauthorized, message: "invalid webhook authentication")
            }
            let rendered = try WebhookPayload.native(data: rawBody)
            let clientMessageID = WebhookCrypto.deterministicClientMessageID([
                workspaceID.uuidString.lowercased(),
                installationID.uuidString.lowercased(),
                deliveryID,
            ])
            return try await writeMessage(
                conn: conn,
                workspaceID: workspaceID,
                installationID: installationID,
                channelID: channelID,
                authorMemberID: authorMemberID,
                label: label,
                mode: .native,
                deliveryID: deliveryID,
                bodyHash: "sha256:\(bodySHA256)",
                dedupeWindowStart: nil,
                clientMessageID: clientMessageID,
                rendered: rendered
            )
        }
        return try Self.ingressResponse(result, request: originalRequest, context: context)
    }

    @Sendable
    func receiveSlackCompatible(
        _ originalRequest: Request, context: AppRequestContext
    ) async throws -> Response {
        let token = try context.parameters.require("token")
        guard let workspaceID = WebhookCrypto.workspaceID(fromSlackToken: token) else {
            throw HTTPError(.unauthorized, message: "invalid webhook authentication")
        }
        let rawBody = try await Self.collectBody(originalRequest)
        let bodySHA256 = WebhookCrypto.sha256Hex(rawBody)
        let tokenHash = WebhookCrypto.tokenHash(token)
        let now = Date()
        let bucketEpoch = floor(now.timeIntervalSince1970 / Self.slackDedupeWindowSeconds)
            * Self.slackDedupeWindowSeconds
        let dedupeWindowStart = Date(timeIntervalSince1970: bucketEpoch)

        let result = try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
            let rows = try await conn.query(
                """
                SELECT wi.id, wi.channel_id, wi.author_member_id, wi.label
                  FROM webhook_secret_key wsk
                  JOIN webhook_installation wi
                    ON wi.workspace_id = wsk.workspace_id
                   AND wi.id = wsk.installation_id
                 WHERE wsk.workspace_id = \(workspaceID)
                   AND wsk.mode = 'slack_compatible'
                   AND wsk.token_hash = \(tokenHash)
                   AND wsk.revoked_at IS NULL
                   AND wsk.valid_from <= now()
                   AND (wsk.valid_until IS NULL OR wsk.valid_until > now())
                   AND wi.mode = 'slack_compatible'
                   AND wi.revoked_at IS NULL
                 FOR SHARE OF wi, wsk
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.unauthorized, message: "invalid webhook authentication")
            }
            let (installationID, channelID, authorMemberID, label) = try row.decode(
                (UUID, UUID, UUID, String).self
            )
            // Parse after authenticating the URL secret so malformed payload
            // details cannot be used as an installation-existence oracle.
            let rendered = try WebhookPayload.slackCompatible(data: rawBody)
            let clientMessageID = WebhookCrypto.deterministicClientMessageID([
                workspaceID.uuidString.lowercased(),
                installationID.uuidString.lowercased(),
                bodySHA256,
                String(Int64(bucketEpoch)),
            ])
            return try await writeMessage(
                conn: conn,
                workspaceID: workspaceID,
                installationID: installationID,
                channelID: channelID,
                authorMemberID: authorMemberID,
                label: label,
                mode: .slackCompatible,
                deliveryID: nil,
                bodyHash: "sha256:\(bodySHA256)",
                dedupeWindowStart: dedupeWindowStart,
                clientMessageID: clientMessageID,
                rendered: rendered
            )
        }
        return try Self.ingressResponse(result, request: originalRequest, context: context)
    }

    // MARK: - Atomic write path

    private struct IngressResult: Sendable {
        let receiptID: UUID
        let messageID: UUID
        let seq: Int64
        let duplicate: Bool
    }

    private func writeMessage(
        conn: PostgresConnection,
        workspaceID: UUID,
        installationID: UUID,
        channelID: UUID,
        authorMemberID: UUID,
        label: String,
        mode: WebhookMode,
        deliveryID: String?,
        bodyHash: String,
        dedupeWindowStart: Date?,
        clientMessageID: UUID,
        rendered: WebhookRenderedMessage
    ) async throws -> IngressResult {
        let receiptRows = try await conn.query(
            """
            INSERT INTO webhook_receipt
              (workspace_id, installation_id, mode, delivery_id, body_sha256,
               dedupe_window_start, client_msg_id)
            VALUES
              (\(workspaceID), \(installationID), \(mode.rawValue), \(deliveryID),
               \(bodyHash), \(dedupeWindowStart), \(clientMessageID))
            ON CONFLICT DO NOTHING
            RETURNING id
            """,
            logger: db.logger
        ).collect()

        guard let receiptRow = receiptRows.first else {
            let existing: [PostgresRow]
            if mode == .native {
                existing = try await conn.query(
                    """
                    SELECT id, message_id, message_seq
                      FROM webhook_receipt
                     WHERE workspace_id = \(workspaceID)
                       AND installation_id = \(installationID)
                       AND mode = 'native'
                       AND delivery_id = \(deliveryID)
                    """,
                    logger: db.logger
                ).collect()
            } else {
                existing = try await conn.query(
                    """
                    SELECT id, message_id, message_seq
                      FROM webhook_receipt
                     WHERE workspace_id = \(workspaceID)
                       AND installation_id = \(installationID)
                       AND mode = 'slack_compatible'
                       AND body_sha256 = \(bodyHash)
                       AND dedupe_window_start = \(dedupeWindowStart)
                    """,
                    logger: db.logger
                ).collect()
            }
            guard let row = existing.first else {
                throw HTTPError(.conflict, message: "webhook receipt conflict")
            }
            let (receiptID, messageID, seq) = try row.decode((UUID, UUID?, Int64?).self)
            guard let messageID, let seq else {
                throw HTTPError(.conflict, message: "webhook receipt is incomplete")
            }
            return .init(receiptID: receiptID, messageID: messageID, seq: seq, duplicate: true)
        }
        let receiptID = try receiptRow.decode(UUID.self)
        let hlcTs = Int64(Date().timeIntervalSince1970 * 1_000)
        var props = rendered.clientProps
        props["source"] = "external_webhook"
        props["webhook_installation_id"] = installationID.uuidString
        props["webhook_mode"] = mode.rawValue
        props["webhook_label"] = label
        let propsJSON = Self.jsonString(props)

        let messageRows = try await conn.query(
            """
            WITH bumped AS (
              UPDATE channel_seq
                 SET last_seq = last_seq + 1
               WHERE channel_id = \(channelID)
                 AND workspace_id = \(workspaceID)
              RETURNING last_seq AS seq
            )
            INSERT INTO message
              (workspace_id, channel_id, seq, hlc_ts, hlc_count,
               author_member_id, type, body, props, client_msg_id)
            SELECT \(workspaceID), \(channelID), b.seq, \(hlcTs), 0,
                   \(authorMemberID), 'text', \(rendered.body), \(propsJSON)::jsonb,
                   \(clientMessageID)
              FROM bumped b
            RETURNING id, seq
            """,
            logger: db.logger
        ).collect()
        guard let messageRow = messageRows.first else {
            throw HTTPError(.notFound, message: "webhook channel is not provisioned")
        }
        let (messageID, seq) = try messageRow.decode((UUID, Int64).self)
        let centChannel = "ch:ws\(workspaceID.uuidString).\(channelID.uuidString)"
        let outboxPayload = MessageRoutes.broadcastPayload(
            centChannel: centChannel,
            messageID: messageID,
            channelID: channelID,
            seq: seq,
            type: "text",
            body: rendered.body,
            authorMemberID: authorMemberID,
            hlcTs: hlcTs,
            hlcCount: 0
        )
        _ = try await conn.query(
            """
            INSERT INTO outbox (workspace_id, kind, method, payload, partition_key)
            VALUES (\(workspaceID), 'broadcast', 'publish', \(outboxPayload)::jsonb, \(channelID))
            """,
            logger: db.logger
        )
        _ = try await conn.query(
            """
            UPDATE webhook_receipt
               SET message_id = \(messageID), message_seq = \(seq)
             WHERE id = \(receiptID)
               AND workspace_id = \(workspaceID)
            """,
            logger: db.logger
        )
        return .init(receiptID: receiptID, messageID: messageID, seq: seq, duplicate: false)
    }

    // MARK: - Helpers

    private func withTenantTransactionUnwrapped<Result: Sendable>(
        workspaceID: UUID,
        _ body: @Sendable (PostgresConnection) async throws -> Result
    ) async throws -> Result {
        do {
            return try await db.withTenantTransaction(workspaceID: workspaceID, body)
        } catch let error as PostgresTransactionError {
            if let http = error.closureError as? HTTPError { throw http }
            throw error
        }
    }

    private static func collectBody(_ originalRequest: Request) async throws -> Data {
        var request = originalRequest
        do {
            let buffer = try await request.collectBody(upTo: WebhookPayload.maximumBodyBytes)
            return Data(buffer.readableBytesView)
        } catch is NIOTooManyBytesError {
            throw HTTPError(.contentTooLarge, message: "webhook body exceeds 262144 bytes")
        }
    }

    private static func ingressResponse(
        _ result: IngressResult,
        request: Request,
        context: AppRequestContext
    ) throws -> Response {
        var response = try WebhookIngressResponse(
            receiptId: result.receiptID,
            messageId: result.messageID,
            seq: result.seq,
            duplicate: result.duplicate
        ).response(from: request, context: context)
        response.status = result.duplicate ? .ok : .created
        return response
    }

    private static func secretResponse(
        installation: WebhookInstallationDTO,
        workspaceID: UUID,
        keyID: UUID,
        mode: WebhookMode,
        secretRef: String?,
        slackToken: String?,
        signingMasterKey: String,
        overlapSeconds: Int?
    ) -> WebhookSecretResponse {
        switch mode {
        case .native:
            let secret = WebhookCrypto.nativeSecret(
                masterKey: signingMasterKey, secretRef: secretRef!
            )
            return WebhookSecretResponse(
                installation: installation,
                keyId: keyID,
                secret: secret,
                url: "/v1/webhooks/\(workspaceID.uuidString.lowercased())/\(installation.id.uuidString.lowercased())",
                signatureVersion: "v1",
                algorithm: "HMAC-SHA256",
                overlapSeconds: overlapSeconds
            )
        case .slackCompatible:
            return WebhookSecretResponse(
                installation: installation,
                keyId: keyID,
                secret: nil,
                url: "/hooks/\(slackToken!)",
                signatureVersion: nil,
                algorithm: nil,
                overlapSeconds: overlapSeconds
            )
        }
    }

    private static func disableCaching(_ response: inout Response) {
        response.headers[.cacheControl] = "no-store"
        response.headers[HTTPField.Name("Pragma")!] = "no-cache"
    }

    private static func humanPrincipal(_ context: AppRequestContext) throws -> AuthPrincipal {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "human workspace admin required")
        }
        return principal
    }

    private static func workspaceID(
        _ context: AppRequestContext, principal: AuthPrincipal
    ) throws -> UUID {
        let workspaceID = try pathUUID(context, name: "ws")
        guard workspaceID == principal.workspaceID else {
            throw HTTPError(.forbidden, message: "workspace scope mismatch")
        }
        return workspaceID
    }

    private static func installationID(_ context: AppRequestContext) throws -> UUID {
        try pathUUID(context, name: "installation")
    }

    private static func pathUUID(_ context: AppRequestContext, name: String) throws -> UUID {
        let raw = try context.parameters.require(name)
        guard let id = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid \(name) id")
        }
        return id
    }

    private static func requiredUUID(_ raw: String, label: String) throws -> UUID {
        guard let id = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid \(label)")
        }
        return id
    }

    private static func normalizedMode(_ raw: String) throws -> WebhookMode {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard let mode = WebhookMode(rawValue: value) else {
            throw HTTPError(.badRequest, message: "mode must be native or slack_compatible")
        }
        return mode
    }

    private static func normalizedLabel(_ raw: String?) throws -> String {
        let value = (raw ?? "Incoming Webhook").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.count <= 80,
              value.unicodeScalars.allSatisfy({ !$0.properties.isControl })
        else {
            throw HTTPError(.badRequest, message: "label must contain 1...80 printable characters")
        }
        return value
    }

    private static func validatedOverlapSeconds(_ raw: Int?) throws -> Int {
        let value = raw ?? 24 * 60 * 60
        guard (0...maximumRotationOverlapSeconds).contains(value) else {
            throw HTTPError(
                .badRequest,
                message: "overlapSeconds must be between 0 and \(maximumRotationOverlapSeconds)"
            )
        }
        return value
    }

    private static func requireWorkspaceAdmin(
        conn: PostgresConnection,
        logger: Logger,
        principal: AuthPrincipal
    ) async throws -> String {
        let rows = try await conn.query(
            """
            SELECT ms.role::text
              FROM membership ms
              JOIN member m
                ON m.id = ms.member_id AND m.workspace_id = ms.workspace_id
             WHERE ms.member_id = \(principal.memberID)
               AND ms.left_at IS NULL
               AND m.status = 'active'
               AND m.deleted_at IS NULL
             ORDER BY CASE ms.role::text
                        WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2
                      END
             LIMIT 1
            """,
            logger: logger
        ).collect()
        guard let role = try rows.first?.decode(String.self),
              role == "owner" || role == "admin"
        else {
            throw HTTPError(.forbidden, message: "workspace admin required")
        }
        return role
    }

    private static func lockMutation(
        conn: PostgresConnection,
        logger: Logger,
        key: String
    ) async throws {
        _ = try await conn.query(
            "SELECT pg_advisory_xact_lock(hashtextextended(\(key), 0))",
            logger: logger
        )
    }

    private static func insertAudit(
        conn: PostgresConnection,
        logger: Logger,
        id: UUID,
        workspaceID: UUID,
        principal: AuthPrincipal,
        action: String,
        targetType: String,
        targetID: UUID,
        detail: [String: Any]
    ) async throws {
        let detailJSON = jsonString(detail)
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (id, workspace_id, actor_member_id, subject_member_id, action,
               target_type, target_id, via_token_id, detail)
            VALUES
              (\(id), \(workspaceID), \(principal.memberID), \(principal.memberID),
               \(action), \(targetType), \(targetID), \(principal.tokenID), \(detailJSON)::jsonb)
            """,
            logger: logger
        )
    }

    private static func jsonString(_ object: Any) -> String {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let string = String(data: data, encoding: .utf8)
        else { return "{}" }
        return string
    }

    private static func decodeInstallation(_ row: PostgresRow) throws -> WebhookInstallationDTO {
        let (id, channelID, authorMemberID, mode, label, revokedAt, createdAt, updatedAt) = try row
            .decode((UUID, UUID, UUID, String, String, Date?, Date, Date).self)
        return .init(
            id: id,
            channelId: channelID,
            authorMemberId: authorMemberID,
            mode: mode,
            label: label,
            status: revokedAt == nil ? "active" : "revoked",
            createdAtMs: Int64(createdAt.timeIntervalSince1970 * 1_000),
            updatedAtMs: Int64(updatedAt.timeIntervalSince1970 * 1_000)
        )
    }
}

enum WebhookMode: String, Sendable {
    case native
    case slackCompatible = "slack_compatible"
}

private struct CreateWebhookRequest: Decodable, Sendable {
    let channelId: String
    let mode: String
    let label: String?
}

private struct RotateWebhookRequest: Decodable, Sendable {
    let overlapSeconds: Int?
}

struct WebhookInstallationDTO: Codable, Sendable {
    let id: UUID
    let channelId: UUID
    let authorMemberId: UUID
    let mode: String
    let label: String
    let status: String
    let createdAtMs: Int64
    let updatedAtMs: Int64
}

private struct WebhookInstallationListResponse: ResponseEncodable, Sendable {
    let installations: [WebhookInstallationDTO]
}

private struct WebhookSecretResponse: ResponseEncodable, Sendable {
    let installation: WebhookInstallationDTO
    let keyId: UUID
    /// Native mode only; returned once and never persisted.
    let secret: String?
    /// Slack-compatible mode contains the one-time secret URL.
    let url: String
    let signatureVersion: String?
    let algorithm: String?
    let overlapSeconds: Int?
}

private struct WebhookRevokeResponse: ResponseEncodable, Sendable {
    let installation: WebhookInstallationDTO
    let revoked: Bool
}

private struct WebhookIngressResponse: ResponseEncodable, Sendable {
    let receiptId: UUID
    let messageId: UUID
    let seq: Int64
    let duplicate: Bool
}
