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
        errorMessage: String? = nil
    ) -> some View {
        MomoAgentCredentialManagementContent(
            copy: MomoWorkspaceCopy(language: .korean),
            credentials: [
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
                    id: UUID(uuidString: "00000000-0000-7000-8000-000000339102")!,
                    agentMemberId: agent,
                    serverStatus: "revoked",
                    scopes: ["agent:jobs:read", "messages:write"],
                    label: "Hermes gateway 이전 값",
                    lastUsedAtMs: 1_799_900_000_000,
                    expiresAtMs: nil,
                    revokedAtMs: 1_800_000_100_000,
                    createdAtMs: 1_799_000_000_000
                ),
            ],
            isLoading: false,
            actionInFlight: false,
            notice: notice,
            errorMessage: errorMessage,
            issueOrRotate: {},
            retry: {},
            requestRevoke: { _ in }
        )
        .padding(16)
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

    func testCredentialRevealLargeTypeSnapshot() throws {
        let surface = revealSurface(.dark, width: 440, height: 720)
            .environment(\.dynamicTypeSize, .accessibility1)
        assertSnapshot(
            of: try render(surface, scheme: .dark, size: CGSize(width: 440, height: 720)),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "large-type"
        )
    }
}
