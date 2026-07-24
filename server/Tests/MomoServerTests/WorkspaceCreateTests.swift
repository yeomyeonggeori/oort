import Foundation
import Hummingbird
import XCTest
@testable import MomoServer

/// MOMO-589 / ADR-0117 §D1-A — POST /v1/workspaces input validation and the
/// instance-operator authorization contract for the create surface. All
/// pure-unit (no DB); the live seed/login/409 roundtrip lives in
/// `scripts/verify_workspace_rest_create.sh`.
final class WorkspaceCreateTests: XCTestCase {
    private typealias R = ProviderLinkRoutes

    // MARK: - Slug normalization

    func testSlugLowercasesAndTrims() throws {
        XCTAssertEqual(try WorkspaceRoutes.normalizedSlug("  Acme-Team  "), "acme-team")
        XCTAssertEqual(try WorkspaceRoutes.normalizedSlug("A"), "a")
        XCTAssertEqual(try WorkspaceRoutes.normalizedSlug("team01"), "team01")
        // Exactly 63 chars is the upper bound.
        let maxSlug = String(repeating: "a", count: 63)
        XCTAssertEqual(try WorkspaceRoutes.normalizedSlug(maxSlug), maxSlug)
    }

    func testSlugRejectsInvalidShapes() {
        for invalid in [
            "",                                   // empty
            "   ",                                // whitespace only
            "-acme",                             // leading hyphen
            "acme-",                             // trailing hyphen
            "ac me",                             // internal space
            "acme_team",                         // underscore not allowed
            "acme.team",                         // dot not allowed
            "café",                              // non-ascii
            String(repeating: "a", count: 64),   // one over the 63 limit
        ] {
            XCTAssertThrowsError(
                try WorkspaceRoutes.normalizedSlug(invalid),
                "expected slug rejection for \(invalid.debugDescription)"
            ) { error in
                XCTAssertEqual((error as? HTTPError)?.status, .badRequest)
            }
        }
    }

    // MARK: - Name normalization (shared with PATCH)

    func testNameTrimsAndBounds() throws {
        XCTAssertEqual(try WorkspaceRoutes.normalizedName("  Acme  "), "Acme")
        let maxName = String(repeating: "n", count: 80)
        XCTAssertEqual(try WorkspaceRoutes.normalizedName(maxName), maxName)
    }

    func testNameRejectsEmptyOversizedAndControl() {
        for invalid in ["", "   ", String(repeating: "n", count: 81), "bad\u{0007}name"] {
            XCTAssertThrowsError(try WorkspaceRoutes.normalizedName(invalid)) { error in
                XCTAssertEqual((error as? HTTPError)?.status, .badRequest)
            }
        }
    }

    // MARK: - Create-surface operator authorization (MOMO-583 model)

    /// The create surface reuses `isProviderLinkOperatorAuthorized`: minting a
    /// tenant on the shared instance requires the same authority as editing the
    /// instance-global provider link, NOT mere workspace ownership.
    func testCreateRequiresInstanceOperatorAuthority() {
        let listed = ["ops@momo.test", "admin@momo.test"]

        // platform:read scope authorizes regardless of role/email.
        XCTAssertTrue(R.isProviderLinkOperatorAuthorized(
            kind: .human, scopes: ["platform:read"], workspaceRole: nil,
            verifiedEmail: nil, platformAdminEmails: listed))

        // Listed instance operator: owner/admin + verified + allowlisted.
        XCTAssertTrue(R.isProviderLinkOperatorAuthorized(
            kind: .human, scopes: [], workspaceRole: .owner,
            verifiedEmail: "ops@momo.test", platformAdminEmails: listed))
        XCTAssertTrue(R.isProviderLinkOperatorAuthorized(
            kind: .human, scopes: [], workspaceRole: .admin,
            verifiedEmail: "Admin@Momo.test", platformAdminEmails: listed))

        // An ordinary owner/admin NOT on the allowlist is denied.
        XCTAssertFalse(R.isProviderLinkOperatorAuthorized(
            kind: .human, scopes: [], workspaceRole: .owner,
            verifiedEmail: "someone@other.test", platformAdminEmails: listed))
        // Listed but email unverified is denied.
        XCTAssertFalse(R.isProviderLinkOperatorAuthorized(
            kind: .human, scopes: [], workspaceRole: .owner,
            verifiedEmail: nil, platformAdminEmails: listed))
        // Plain member/guest is denied.
        XCTAssertFalse(R.isProviderLinkOperatorAuthorized(
            kind: .human, scopes: [], workspaceRole: .member,
            verifiedEmail: "ops@momo.test", platformAdminEmails: listed))
        // Non-human principals can never mint a tenant.
        XCTAssertFalse(R.isProviderLinkOperatorAuthorized(
            kind: .agent, scopes: ["platform:read"], workspaceRole: .owner,
            verifiedEmail: "ops@momo.test", platformAdminEmails: listed))
    }
}
