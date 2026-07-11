import XCTest
import SwiftUI
import SnapshotTesting
import MomoCore
@testable import MomoMac

@MainActor
final class AgentCredentialSnapshotTests: XCTestCase {
    private let agent = MemberID(uuidString: "00000000-0000-7000-8000-000000339100")!

    private func managementSurface(
        _ scheme: ColorScheme,
        width: CGFloat = 480,
        height: CGFloat = 620,
        notice: String? = "자격증명을 폐기했습니다. 새 env 값을 반영하세요.",
        errorMessage: String? = nil,
        presentation: MomoAgentCredentialManagementPresentation = .grouped,
        includeLongThirdCredential: Bool = false,
        outerPadding: CGFloat = 16
    ) -> some View {
        let revokedCredentialID = UUID(uuidString: "00000000-0000-7000-8000-000000339102")!
        var credentials = [
            MomoAgentCredential(
                id: UUID(uuidString: "00000000-0000-7000-8000-000000339101")!,
                agentMemberId: agent,
                serverStatus: "active",
                scopes: ["agent:jobs:read", "messages:write"],
                label: "Hermes gateway",
                lastUsedAtMs: nil,
                expiresAtMs: nil,
                revokedAtMs: nil,
                createdAtMs: 1_800_000_000_000
            ),
            MomoAgentCredential(
                id: revokedCredentialID,
                agentMemberId: agent,
                serverStatus: "revoked",
                scopes: ["agent:jobs:read", "messages:write"],
                label: "Hermes gateway 이전 값",
                lastUsedAtMs: 1_799_900_000_000,
                expiresAtMs: nil,
                revokedAtMs: 1_800_000_100_000,
                createdAtMs: 1_799_000_000_000
            ),
        ]
        if includeLongThirdCredential {
            credentials.append(
                MomoAgentCredential(
                    id: UUID(uuidString: "00000000-0000-7000-8000-000000339104")!,
                    agentMemberId: agent,
                    serverStatus: "active",
                    scopes: ["agent:jobs:read", "messages:write"],
                    label: "서울 운영팀 Hermes gateway 장기 이름",
                    lastUsedAtMs: 1_799_950_000_000,
                    expiresAtMs: 1_800_086_400_000,
                    revokedAtMs: nil,
                    createdAtMs: 1_798_000_000_000
                )
            )
        }

        return MomoAgentCredentialManagementContent(
            copy: MomoWorkspaceCopy(language: .korean),
            credentials: credentials,
            isLoading: false,
            actionInFlight: false,
            notice: notice.map {
                MomoAgentCredentialNotice(credentialID: revokedCredentialID, message: $0)
            },
            errorMessage: errorMessage,
            presentation: presentation,
            issueOrRotate: {},
            retry: {},
            requestRevoke: { _ in }
        )
        .padding(outerPadding)
        .frame(width: width, height: height, alignment: .topLeading)
        .background(Color(nsColor: .windowBackgroundColor))
        .environment(\.colorScheme, scheme)
    }

    private func revealSurface(
        _ scheme: ColorScheme,
        width: CGFloat = 520,
        height: CGFloat = 620
    ) -> some View {
        let credential = MomoAgentCredential(
            id: UUID(uuidString: "00000000-0000-7000-8000-000000339103")!,
            agentMemberId: agent,
            serverStatus: "active",
            scopes: ["agent:jobs:read", "messages:write"],
            label: "Hermes gateway",
            lastUsedAtMs: nil,
            expiresAtMs: nil,
            revokedAtMs: nil,
            createdAtMs: 1_800_000_000_000
        )
        // This visual fixture deliberately uses a non-secret placeholder. Raw
        // issuance responses are never written to snapshot fixtures.
        let reveal = MomoAgentCredentialReveal(
            credential: credential,
            token: "not-a-real-token",
            tokenType: "Bearer",
            rotatedCredentialCount: 1,
            rotationGraceEndsAtMs: 1_800_086_400_000
        )
        return MomoAgentCredentialRevealSheet(
            copy: MomoWorkspaceCopy(language: .english),
            reveal: reveal
        )
        .frame(width: width, height: height)
        .background(Color(nsColor: .windowBackgroundColor))
        .environment(\.colorScheme, scheme)
    }

    private func render<Content: View>(
        _ content: Content,
        scheme: ColorScheme,
        size: CGSize,
        appearanceName: NSAppearance.Name? = nil
    ) throws -> NSImage {
        let resolvedAppearanceName = appearanceName ?? (scheme == .dark ? .darkAqua : .aqua)
        let hostingView = NSHostingView(rootView: content)
        hostingView.frame = CGRect(origin: .zero, size: size)
        hostingView.appearance = NSAppearance(named: resolvedAppearanceName)
        hostingView.layoutSubtreeIfNeeded()
        hostingView.displayIfNeeded()

        guard let representation = hostingView.bitmapImageRepForCachingDisplay(in: hostingView.bounds) else {
            throw XCTSkip("NSHostingView produced no bitmap on this host")
        }
        hostingView.cacheDisplay(in: hostingView.bounds, to: representation)
        let image = NSImage(size: size)
        image.addRepresentation(representation)
        return image
    }

    func testCredentialManagementLightSnapshot() throws {
        assertSnapshot(
            of: try render(managementSurface(.light), scheme: .light, size: CGSize(width: 480, height: 620)),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light"
        )
    }

    func testCredentialManagementDarkSnapshot() throws {
        assertSnapshot(
            of: try render(managementSurface(.dark), scheme: .dark, size: CGSize(width: 480, height: 620)),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark"
        )
    }

    func testCredentialRevealLightSnapshot() throws {
        assertSnapshot(
            of: try render(revealSurface(.light), scheme: .light, size: CGSize(width: 520, height: 620)),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light"
        )
    }

    func testCredentialRevealDarkSnapshot() throws {
        assertSnapshot(
            of: try render(revealSurface(.dark), scheme: .dark, size: CGSize(width: 520, height: 620)),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark"
        )
    }

    func testCredentialManagementSmallWindowIncreasedContrastSnapshot() throws {
        let surface = managementSurface(
            .light,
            width: 360,
            height: 720,
            notice: nil,
            errorMessage: "관리자 세션이 만료되었습니다. 다시 로그인한 뒤 새로고침하세요."
        )
        assertSnapshot(
            of: try render(
                surface,
                scheme: .light,
                size: CGSize(width: 360, height: 720),
                appearanceName: .accessibilityHighContrastAqua
            ),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "small-increased-contrast"
        )
    }

    func testCredentialRevealConstrainedWindowSnapshot() throws {
        let surface = revealSurface(.dark, width: 440, height: 720)
        assertSnapshot(
            of: try render(surface, scheme: .dark, size: CGSize(width: 440, height: 720)),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "constrained-window"
        )
    }

    func testCredentialManagementPopoverWidthSnapshot() throws {
        let surface = managementSurface(
            .light,
            width: 290,
            height: 620,
            presentation: .popover,
            includeLongThirdCredential: true,
            outerPadding: 0
        )
        assertSnapshot(
            of: try render(surface, scheme: .light, size: CGSize(width: 290, height: 620)),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "popover-effective-width"
        )
    }
}
