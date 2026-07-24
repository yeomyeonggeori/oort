import Combine
import Foundation
import MomoCore

// MOMO-590 / W-S1: in-app "새 워크스페이스 만들기" flow. Consumes the operator
// self-serve contract POST /v1/workspaces {slug, name} -> 201 {workspaceId}
// (589). Authorization reuses the registered-operator App JWT carried by
// MomoInviteAdminContext, the same principal as the provider-link surface (574).
// The server is always the authority; the client-side guards below exist only so
// the sheet gives immediate feedback and a sensible auto-derived slug.

/// Workspace name rules. The server btrims and bounds the length; the client
/// mirrors the bound so Create is not offered for an obviously empty name.
enum MomoWorkspaceName {
    static let maximumLength = 200

    static func normalized(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func isValid(_ raw: String) -> Bool {
        let trimmed = normalized(raw)
        return !trimmed.isEmpty && trimmed.count <= maximumLength
    }
}

/// Slug rules mirroring the canonical server seeding path
/// (`infra/prod/create_workspace.sql`: `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`,
/// lowercased and btrimmed). A slug is 1-63 chars, lowercase alphanumeric with
/// interior hyphens, and never starts or ends with a hyphen.
enum MomoWorkspaceSlug {
    static let maximumLength = 63

    /// Lowercase + trim, matching how the server stores the value.
    static func normalized(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// Best-effort slug derived from a human name: lowercase, non-alphanumeric
    /// runs collapse to a single hyphen, and leading/trailing hyphens are dropped.
    /// Produces "" when the name has no usable characters (the caller keeps the
    /// field editable so the operator can type a slug directly).
    static func derive(from name: String) -> String {
        let lowered = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var result = ""
        var pendingHyphen = false
        for scalar in lowered.unicodeScalars {
            let isAllowed = (scalar >= "a" && scalar <= "z") || (scalar >= "0" && scalar <= "9")
            if isAllowed {
                if pendingHyphen, !result.isEmpty {
                    result.append("-")
                }
                pendingHyphen = false
                result.unicodeScalars.append(scalar)
                if result.count >= maximumLength {
                    break
                }
            } else {
                // Any non-alphanumeric character (space, "_", Hangul, punctuation)
                // becomes a single hyphen between alphanumeric runs.
                pendingHyphen = true
            }
        }
        return String(result.prefix(maximumLength))
    }

    static func isValid(_ raw: String) -> Bool {
        let slug = normalized(raw)
        guard !slug.isEmpty, slug.count <= maximumLength else { return false }
        return slug.range(
            of: #"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"#,
            options: .regularExpression
        ) != nil
    }
}

/// Body for `POST /v1/workspaces`. Closed-world: only slug + name are sent.
struct MomoWorkspaceCreateRequest: Encodable, Equatable, Sendable {
    let slug: String
    let name: String
}

/// The `201 {workspaceId}` payload, resolved to a typed workspace id plus the
/// slug/name the operator just created (kept for the success + hand-off copy).
struct MomoCreatedWorkspace: Equatable, Sendable {
    let workspaceId: WorkspaceID
    let slug: String
    let name: String
}

/// Raw decode target. The server emits camelCase `workspaceId` (matching the
/// join/login DTOs), so no key strategy is needed.
struct MomoWorkspaceCreateResponse: Decodable {
    let workspaceId: String
}

protocol MomoWorkspaceCreateClient: Sendable {
    func create(
        context: MomoInviteAdminContext,
        request: MomoWorkspaceCreateRequest
    ) async throws -> MomoCreatedWorkspace
}

enum MomoWorkspaceCreateClientError: Error, Equatable, LocalizedError, Sendable {
    case offline
    case invalidResponse
    case http(status: Int, message: String)
    case transport

    var errorDescription: String? {
        switch self {
        case .offline:
            return "The server is offline."
        case .invalidResponse:
            return "The server returned an unreadable workspace response."
        case .http(_, let message):
            return message
        case .transport:
            return "The workspace request could not reach the server."
        }
    }
}

/// User-facing failure classification. 409 is called out as a distinct
/// `slugConflict` so the sheet can point the error at the slug field.
enum MomoWorkspaceCreateFailure: Equatable {
    case invalidInput
    case slugConflict
    case unauthorized
    case forbidden
    case offline
    case invalidResponse
    case other

    /// True when the failure is about the slug specifically, so the sheet can
    /// anchor the message on the slug field and keep the name untouched.
    var isSlugSpecific: Bool { self == .slugConflict }

    static func classify(_ error: Error) -> Self {
        if let clientError = error as? MomoWorkspaceCreateClientError {
            switch clientError {
            case .offline, .transport:
                return .offline
            case .invalidResponse:
                return .invalidResponse
            case .http(let status, _):
                switch status {
                case 400: return .invalidInput
                case 401: return .unauthorized
                case 403: return .forbidden
                case 409: return .slugConflict
                default: return .other
                }
            }
        }
        if let urlError = error as? URLError,
           [
               .cannotConnectToHost,
               .cannotFindHost,
               .dnsLookupFailed,
               .networkConnectionLost,
               .notConnectedToInternet,
               .timedOut,
           ].contains(urlError.code)
        {
            return .offline
        }
        return .other
    }
}

enum MomoWorkspaceCreateOperation: Equatable {
    case idle
    case creating

    var isWorking: Bool { self != .idle }
}

@MainActor
final class MomoWorkspaceCreateModel: ObservableObject {
    @Published private(set) var nameDraft: String = ""
    @Published private(set) var slugDraft: String = ""
    @Published private(set) var operation: MomoWorkspaceCreateOperation = .idle
    @Published private(set) var failure: MomoWorkspaceCreateFailure?
    @Published private(set) var created: MomoCreatedWorkspace?

    /// Once the operator edits the slug, name changes stop overwriting it. Clearing
    /// the slug field resumes auto-derivation.
    private(set) var slugManuallyEdited = false

    private let context: MomoInviteAdminContext?
    private let client: any MomoWorkspaceCreateClient

    init(
        context: MomoInviteAdminContext?,
        client: any MomoWorkspaceCreateClient
    ) {
        self.context = context
        self.client = client
    }

    var isWorking: Bool { operation.isWorking }

    /// No operator context (a demo/unauthenticated session) means the surface can
    /// never authorize a create; the sheet renders its unavailable state.
    var isAuthorized: Bool { context != nil }

    var nameIsValid: Bool { MomoWorkspaceName.isValid(nameDraft) }
    var slugIsValid: Bool { MomoWorkspaceSlug.isValid(slugDraft) }

    var canCreate: Bool {
        !isWorking && created == nil && isAuthorized && nameIsValid && slugIsValid
    }

    func updateName(_ value: String) {
        nameDraft = value
        if !slugManuallyEdited {
            slugDraft = MomoWorkspaceSlug.derive(from: value)
        }
        failure = nil
    }

    func updateSlug(_ value: String) {
        slugDraft = value
        // A non-empty edit pins the slug; clearing it hands control back to the
        // name-derived slug.
        slugManuallyEdited = !MomoWorkspaceSlug.normalized(value).isEmpty
        failure = nil
    }

    /// Re-derive the slug from the current name and resume auto-derivation.
    func resetSlugToDerived() {
        slugManuallyEdited = false
        slugDraft = MomoWorkspaceSlug.derive(from: nameDraft)
        failure = nil
    }

    @discardableResult
    func create() async -> Bool {
        guard operation == .idle, created == nil, let context else { return false }
        let name = MomoWorkspaceName.normalized(nameDraft)
        let slug = MomoWorkspaceSlug.normalized(slugDraft)
        guard MomoWorkspaceName.isValid(name), MomoWorkspaceSlug.isValid(slug) else {
            failure = .invalidInput
            return false
        }

        operation = .creating
        failure = nil
        defer { operation = .idle }
        do {
            let result = try await client.create(
                context: context,
                request: MomoWorkspaceCreateRequest(slug: slug, name: name)
            )
            created = result
            return true
        } catch is CancellationError {
            return false
        } catch {
            failure = MomoWorkspaceCreateFailure.classify(error)
            return false
        }
    }
}
