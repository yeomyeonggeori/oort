import XCTest
import SwiftUI
import AppKit
import SnapshotTesting
import MomoCore
@testable import MomoMac

// Canonical light/dark references are intentionally recorded by the orchestrator
// on the repo snapshot machine. Worker runs still rasterize the full fixture and
// verify that the agent/status accent survives the grouped timeline composition.
@MainActor
final class MessageTimelineSnapshotTests: XCTestCase {
    private let size = CGSize(width: 640, height: 520)

    private func fixture(
        _ scheme: ColorScheme,
        presentation: MomoDeveloperModePresentation = .developer(showCosts: true)
    ) -> some View {
        let workspace = WorkspaceID()
        let channel = ChannelID()
        let human = Member(
            id: MemberID(),
            workspaceId: workspace,
            kind: .human,
            displayName: "김지현",
            handle: "jihyun"
        )
        let agent = Member(
            id: MemberID(),
            workspaceId: workspace,
            kind: .agent,
            displayName: "Hermes",
            handle: "hermes"
        )
        let run = RunID()
        let morning = 1_783_910_400_000 as Int64
        let first = Message(
            id: MessageID(), channelId: channel, seq: 128, hlcTs: morning,
            authorMemberId: human.id,
            body: "staging smoke 로컬 확인을 마쳤어요. 오늘 배포 후보도 함께 살펴볼게요.",
            createdAtMs: morning
        )
        let compact = Message(
            id: MessageID(), channelId: channel, seq: 129, hlcTs: morning + 60_000,
            authorMemberId: human.id,
            body: "RLS migration 체크 결과도 이 스레드에 정리했습니다.",
            createdAtMs: morning + 60_000
        )
        let toolResult = Message(
            id: MessageID(), channelId: channel, seq: 130, hlcTs: morning + 120_000,
            authorMemberId: agent.id,
            type: .toolResult,
            props: .object([
                "human_summary": .string("Hermes가 배포 전 확인 항목 3개를 마쳤습니다."),
                "human_detail": .string("migration, runtime smoke, 공지 초안이 모두 준비됐습니다."),
                "tool_name": .string("release_check"),
                "output": .object(["result": .string("3개 항목 확인 완료")]),
            ]),
            runId: run,
            createdAtMs: morning + 120_000
        )
        let partial = AgentPartial(
            runId: RunID(),
            channelId: channel,
            textDelta: "다음 배포 체크리스트를 이어서 확인하고 있습니다.",
            spentMicroUSD: 24_000
        )
        let status = AgentStatus(
            runId: partial.runId,
            agentMemberId: agent.id,
            channelId: channel,
            phase: .streaming,
            runStatus: .running,
            reservedMicroUSD: 80_000,
            spentMicroUSD: 24_000
        )

        return VStack(alignment: .leading, spacing: 0) {
            TimelineDayDivider(
                day: Date(timeIntervalSince1970: Double(morning) / 1_000),
                copy: MomoWorkspaceCopy(language: .korean)
            )
            MessageBubble(
                message: first,
                author: human,
                groupingStyle: .groupStart,
                timelineCopy: MomoWorkspaceCopy(language: .korean),
                presentation: presentation
            )
                .padding(.top, 8)
            MessageBubble(
                message: compact,
                author: human,
                groupingStyle: .compact,
                timelineCopy: MomoWorkspaceCopy(language: .korean),
                presentation: presentation
            )
            MessageBubble(
                message: toolResult,
                author: agent,
                groupingStyle: .groupStart,
                timelineCopy: MomoWorkspaceCopy(language: .korean),
                presentation: presentation
            )
                .padding(.top, 8)
            AgentPartialView(
                partial: partial,
                author: agent,
                status: status,
                presentation: presentation,
                copy: MomoWorkspaceCopy(language: .korean)
            )
                .padding(.top, 8)
        }
        .padding(16)
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .background(Color(nsColor: .textBackgroundColor))
        .environment(\.colorScheme, scheme)
        .environment(\.locale, Locale(identifier: "ko_KR"))
        .environment(\.timeZone, TimeZone(secondsFromGMT: 0)!)
    }

    private func render(
        _ scheme: ColorScheme,
        presentation: MomoDeveloperModePresentation = .developer(showCosts: true)
    ) throws -> NSImage {
        let hostingView = NSHostingView(rootView: fixture(scheme, presentation: presentation))
        hostingView.frame = CGRect(origin: .zero, size: size)
        hostingView.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        hostingView.layoutSubtreeIfNeeded()
        hostingView.displayIfNeeded()

        guard let representation = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(size.width * 2),
            pixelsHigh: Int(size.height * 2),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else {
            throw XCTSkip("NSHostingView produced no timeline bitmap on this host")
        }
        representation.size = size
        hostingView.cacheDisplay(in: hostingView.bounds, to: representation)

        let image = NSImage(size: size)
        image.addRepresentation(representation)
        return image
    }

    private func dualDensityFixture(
        _ scheme: ColorScheme,
        presentation: MomoDeveloperModePresentation
    ) -> some View {
        let workspace = WorkspaceID(uuidString: "00000000-0000-7000-8000-000000000001")!
        let channel = ChannelID(uuidString: "00000000-0000-7000-8000-000000000202")!
        let agent = Member(
            id: MemberID(uuidString: "00000000-0000-7000-8000-000000000103")!,
            workspaceId: workspace,
            kind: .agent,
            displayName: "Hermes",
            handle: "hermes"
        )
        let run = RunID(uuidString: "00000000-0000-7000-8000-000000000370")!
        let approvalID = ApprovalID(uuidString: "00000000-0000-7000-8000-000000000970")!
        let result = Message(
            id: MessageID(uuidString: "00000000-0000-7000-8000-000000000371")!,
            channelId: channel,
            seq: 41,
            hlcTs: 1_783_910_400_000,
            authorMemberId: agent.id,
            type: .toolResult,
            props: .object([
                "human_summary": .string("Hermes가 배포 전 확인 항목 3개를 마쳤습니다."),
                "human_detail": .string("migration과 runtime smoke는 green입니다. 공지 초안에는 긴 한국어 설명과 release owner 확인 항목까지 포함했습니다."),
                "tool_name": .string("release.check"),
                "output": .object(["passed": .int(3), "failed": .int(0)]),
                "context_packet": .object([
                    "scope": .string("#release-room"),
                    "source_count": .int(3),
                ]),
                "spent_micro_usd": .int(51_000),
            ]),
            runId: run,
            createdAtMs: 1_783_910_400_000
        )
        let approval = Message(
            id: MessageID(uuidString: "00000000-0000-7000-8000-000000000372")!,
            channelId: channel,
            seq: 42,
            hlcTs: 1_783_910_460_000,
            authorMemberId: agent.id,
            type: .approvalRequest,
            props: .object([
                "approval_id": .string(approvalID.description),
                "approval_status": .string(ApprovalStatus.pending.rawValue),
                "action_type": .string("github.issue.create"),
                "title": .string("내부 알파 배포 체크리스트 이슈 만들기"),
                "human_summary": .string("Hermes가 GitHub에 내부 알파 배포 체크리스트 이슈를 만들려고 합니다."),
                "human_detail": .string("승인하면 추적용 이슈 하나를 만듭니다."),
                "capability": .object([
                    "provider": .string("github"),
                    "tool_name": .string("github.issue.create"),
                    "risk": .string("write"),
                    "approval_policy": .string("always"),
                ]),
                "estimated_micro_usd": .int(820_000),
            ]),
            runId: run,
            createdAtMs: 1_783_910_460_000
        )
        let cost = CostSnapshot(
            runId: run,
            reservedMicroUSD: 820_000,
            spentMicroUSD: 51_000,
            isReconciled: false,
            wasEstimated: true
        )
        let copy = MomoWorkspaceCopy(language: .korean)

        return VStack(alignment: .leading, spacing: 0) {
            MessageBubble(
                message: result,
                author: agent,
                cost: cost,
                groupingStyle: .groupStart,
                timelineCopy: copy,
                presentation: presentation
            )
            MessageBubble(
                message: approval,
                author: agent,
                cost: cost,
                approvalStatus: .pending,
                onApprovalDecision: { _, _ in },
                groupingStyle: .groupStart,
                timelineCopy: copy,
                presentation: presentation
            )
            .padding(.top, 12)
        }
        .padding(16)
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .background(Color(nsColor: .textBackgroundColor))
        .environment(\.colorScheme, scheme)
        .environment(\.locale, Locale(identifier: "ko_KR"))
    }

    private func renderDualDensity(
        _ scheme: ColorScheme,
        presentation: MomoDeveloperModePresentation
    ) throws -> NSImage {
        let hostingView = NSHostingView(
            rootView: dualDensityFixture(scheme, presentation: presentation)
        )
        hostingView.frame = CGRect(origin: .zero, size: size)
        hostingView.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        hostingView.layoutSubtreeIfNeeded()
        hostingView.displayIfNeeded()

        guard let representation = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(size.width * 2),
            pixelsHigh: Int(size.height * 2),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else {
            throw XCTSkip("NSHostingView produced no dual-density bitmap on this host")
        }
        representation.size = size
        hostingView.cacheDisplay(in: hostingView.bounds, to: representation)
        let image = NSImage(size: size)
        image.addRepresentation(representation)
        return image
    }

    private func requireCanonicalReference(testName: String, named: String) throws {
        let testDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let reference = testDirectory
            .appendingPathComponent("__Snapshots__/MessageTimelineSnapshotTests")
            .appendingPathComponent("\(testName).\(named).png")
        let isRecording = ProcessInfo.processInfo.environment["MOMO_RECORD_SNAPSHOTS"] == "1"
        guard isRecording || FileManager.default.fileExists(atPath: reference.path) else {
            throw XCTSkip("Canonical MOMO-370 snapshot will be recorded by the orchestrator: \(reference.lastPathComponent)")
        }
    }

    private func agentAccentPixelCount(in image: NSImage) throws -> Int {
        guard let tiff = image.tiffRepresentation,
              let representation = NSBitmapImageRep(data: tiff)
        else {
            throw XCTSkip("Rendered timeline image has no readable bitmap")
        }

        var count = 0
        for y in 0..<representation.pixelsHigh {
            for x in 0..<representation.pixelsWide {
                guard let color = representation.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else {
                    continue
                }
                if color.blueComponent > 0.68,
                   color.redComponent > 0.30,
                   color.redComponent < 0.66,
                   color.greenComponent < 0.58,
                   color.blueComponent - color.greenComponent > 0.18 {
                    count += 1
                }
            }
        }
        return count
    }

    private func writeDesignReviewArtifact(_ image: NSImage, named name: String) throws {
        guard let directory = ProcessInfo.processInfo.environment["MOMO_DESIGN_REVIEW_ARTIFACT_DIR"] else {
            return
        }
        let outputDirectory = URL(fileURLWithPath: directory, isDirectory: true)
        try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
        guard let tiff = image.tiffRepresentation,
              let representation = NSBitmapImageRep(data: tiff),
              let png = representation.representation(using: .png, properties: [:])
        else {
            throw XCTSkip("Rendered timeline image could not be encoded as PNG")
        }
        try png.write(to: outputDirectory.appendingPathComponent(name), options: .atomic)
    }

    func testMessageTimelineLightSnapshot() throws {
        try requireCanonicalReference(testName: #function.replacingOccurrences(of: "()", with: ""), named: "light")
        assertSnapshot(
            of: try render(.light),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "light"
        )
    }

    func testMessageTimelineDarkSnapshot() throws {
        try requireCanonicalReference(testName: #function.replacingOccurrences(of: "()", with: ""), named: "dark")
        assertSnapshot(
            of: try render(.dark),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "dark"
        )
    }

    func testGroupedTimelineRasterKeepsAgentStatusAccent() throws {
        for scheme in [ColorScheme.light, .dark] {
            let image = try render(scheme)
            try writeDesignReviewArtifact(
                image,
                named: "momo-369-timeline-\(scheme == .dark ? "dark" : "light").png"
            )
            XCTAssertEqual(image.size, size)
            XCTAssertGreaterThan(
                try agentAccentPixelCount(in: image),
                100,
                "Grouped AGENT badge and streaming status must remain visible in \(scheme) mode"
            )
        }
    }

    func testDualDensityRasterWritesDesignReviewArtifacts() throws {
        let modes: [(String, MomoDeveloperModePresentation)] = [
            ("standard", .standard),
            ("developer-no-cost", .developer(showCosts: false)),
            ("developer", .developer(showCosts: true)),
        ]
        for (mode, presentation) in modes {
            for scheme in [ColorScheme.light, .dark] {
                let image = try renderDualDensity(scheme, presentation: presentation)
                try writeDesignReviewArtifact(
                    image,
                    named: "momo-370-timeline-\(mode)-\(scheme == .dark ? "dark" : "light").png"
                )
                XCTAssertEqual(image.size, size)
            }
        }
    }

    func testDualDensityStandardLightSnapshot() throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "standard-light"
        )
        assertSnapshot(
            of: try renderDualDensity(.light, presentation: .standard),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "standard-light"
        )
    }

    func testDualDensityStandardDarkSnapshot() throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "standard-dark"
        )
        assertSnapshot(
            of: try renderDualDensity(.dark, presentation: .standard),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "standard-dark"
        )
    }

    func testDualDensityDeveloperLightSnapshot() throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "developer-light"
        )
        assertSnapshot(
            of: try renderDualDensity(.light, presentation: .developer(showCosts: true)),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "developer-light"
        )
    }

    func testDualDensityDeveloperDarkSnapshot() throws {
        try requireCanonicalReference(
            testName: #function.replacingOccurrences(of: "()", with: ""),
            named: "developer-dark"
        )
        assertSnapshot(
            of: try renderDualDensity(.dark, presentation: .developer(showCosts: true)),
            as: .image(precision: 0.98, perceptualPrecision: 0.98),
            named: "developer-dark"
        )
    }
}
