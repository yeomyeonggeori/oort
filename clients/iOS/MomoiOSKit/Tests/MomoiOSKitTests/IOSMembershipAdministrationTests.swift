import MomoCore
@testable import MomoiOSKit
import XCTest

final class IOSMembershipAdministrationTests: XCTestCase {
    func testRoleHierarchyFailsClosedForSelfAndPeers() {
        let workspace = WorkspaceID()
        func member(_ role: MembershipRole, name: String) -> Member {
            Member(
                id: MemberID(), workspaceId: workspace, kind: .human,
                displayName: name, handle: name.lowercased(), workspaceRole: role
            )
        }
        let owner = member(.owner, name: "Owner")
        let peerOwner = member(.owner, name: "PeerOwner")
        let admin = member(.admin, name: "Admin")
        let regular = member(.member, name: "Member")
        let guest = member(.guest, name: "Guest")

        XCTAssertEqual(
            IOSMembershipAdministrationPolicy.assignableRoles(actor: owner, target: admin),
            [.owner, .admin, .member, .guest]
        )
        XCTAssertEqual(
            IOSMembershipAdministrationPolicy.assignableRoles(actor: admin, target: guest),
            [.member, .guest]
        )
        XCTAssertTrue(IOSMembershipAdministrationPolicy.canChangeLifecycle(actor: admin, target: regular))
        XCTAssertFalse(IOSMembershipAdministrationPolicy.canChangeLifecycle(actor: admin, target: owner))
        XCTAssertFalse(IOSMembershipAdministrationPolicy.canChangeLifecycle(actor: regular, target: guest))
        XCTAssertFalse(IOSMembershipAdministrationPolicy.canChangeLifecycle(actor: owner, target: owner))
        XCTAssertTrue(IOSMembershipAdministrationPolicy.assignableRoles(actor: owner, target: peerOwner).isEmpty)
    }

    func testMembershipCopyLocalizesLifecycleAndAvoidsTokenJargon() {
        let korean = IOSWorkspaceCopy(isKorean: true)
        let english = IOSWorkspaceCopy(isKorean: false)

        XCTAssertEqual(korean.auditLog, "감사 로그")
        XCTAssertEqual(korean.actorTarget(actor: "상준", target: "Hermes"), "행위자 상준 → 대상 Hermes")
        XCTAssertTrue(korean.suspendExplanation.contains("로그인 세션"))
        XCTAssertTrue(english.leaveWorkspaceExplanation.contains("login sessions"))
        XCTAssertFalse(english.removeExplanation.localizedCaseInsensitiveContains("token"))
    }
}
