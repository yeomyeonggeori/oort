import XCTest
import AppKit
import MomoCore
@testable import MomoMac

final class MomoChannelChromeTests: XCTestCase {
    @MainActor
    func testApprovalInboxSurfaceOwnershipSeparatesStandaloneFromRootComposition() {
        let viewModel = ChatViewModel(backend: LiveChatBackend())

        XCTAssertTrue(ApprovalInboxView(viewModel: viewModel).ownsInspectorSurface)
        XCTAssertFalse(
            ApprovalInboxView(
                viewModel: viewModel,
                inspectorPresentation: .attached
            ).ownsInspectorSurface
        )
    }

    func testInspectorUsesFlatSurfaceChrome() {
        XCTAssertFalse(MomoInspectorPresentation.attached.usesElevatedSurfaceChrome)
        XCTAssertEqual(MomoInspectorPresentation.attached.cornerRadius, 0)
    }

    func testDetailPanePresentationClosesAfterSwitchingPane() {
        var state = MomoDetailPanePresentationState()

        state.present(.settings)
        XCTAssertTrue(state.isPresented)
        XCTAssertEqual(state.pane, .settings)

        state.present(.memberProfile)
        XCTAssertTrue(state.isPresented)
        XCTAssertEqual(state.pane, .memberProfile)

        state.close()
        XCTAssertFalse(state.isPresented)
        XCTAssertEqual(state.pane, .memberProfile)
    }

    func testDetailPaneRedirectPreservesClosedPresentation() {
        var state = MomoDetailPanePresentationState()

        state.present(.alpha)
        state.close()
        state.redirect(to: .approvals)

        XCTAssertFalse(state.isPresented)
        XCTAssertEqual(state.pane, .approvals)
    }

    func testIntegratedHeadersOwnWindowChromeBandWithoutTransparentSpacer() {
        XCTAssertEqual(MomoWindowChromeLayout.integratedHeaderHeight, 52)
        XCTAssertEqual(
            MomoWindowChromeLayout.controlBandHeight,
            MomoWindowChromeLayout.integratedHeaderHeight
        )
        XCTAssertGreaterThan(MomoWindowChromeLayout.centerChromeControlsReservedWidth, 0)
    }

    func testChannelHeaderMenuUsesStableWidthAndLocalizedCloseCopy() {
        XCTAssertEqual(MomoTheme.ChannelHeader.menuWidth, 320)
        XCTAssertEqual(MomoWorkspaceCopy(language: .korean).channelMenu, "채널 메뉴")
        XCTAssertEqual(
            MomoWorkspaceCopy(language: .korean).channelMenuState(isPresented: true),
            "열림"
        )
        XCTAssertEqual(
            MomoWorkspaceCopy(language: .english).channelMenuState(isPresented: false),
            "Collapsed"
        )
        XCTAssertEqual(
            MomoWorkspaceCopy(language: .korean).closeChannelMenu,
            "채널 메뉴 닫기"
        )
        XCTAssertEqual(
            MomoWorkspaceCopy(language: .english).closeChannelMenu,
            "Close channel menu"
        )
    }

    func testCollapsedCenterHeaderStartsAfterMeasuredTrafficLights() {
        XCTAssertEqual(
            MomoWindowChromeLayout.centerHeaderLeadingInset(
                sidebarVisible: true,
                trafficLightTrailingX: 136
            ),
            0
        )
        XCTAssertEqual(
            MomoWindowChromeLayout.centerHeaderLeadingInset(
                sidebarVisible: false,
                trafficLightTrailingX: 136
            ),
            136
        )
        XCTAssertEqual(
            MomoWindowChromeLayout.centerHeaderLeadingInset(sidebarVisible: false),
            MomoWindowChromeLayout.collapsedCenterLeadingInset
        )
        XCTAssertEqual(
            MomoWindowChromeLayout.collapsedCenterLeadingInset
                + MomoTheme.ChannelHeader.edgeInset,
            88
        )
    }

    func testThreeZoneShellConsumesWindowChromeInsetOnce() {
        XCTAssertEqual(
            MomoWindowChromeLayout.shellTopInset(
                windowChromeTopInset: 52
            ),
            52
        )
        XCTAssertEqual(MomoWindowChromeLayout.shellTopInset(windowChromeTopInset: -8), 0)
    }

    func testMeasuredWindowChromeInsetCannotExpandCenterOrInspectorHeaders() {
        XCTAssertEqual(MomoWindowChromeLayout.integratedHeaderHeight, 52)
        XCTAssertEqual(MomoWindowChromeLayout.shellTopInset(windowChromeTopInset: 126), 126)
        XCTAssertEqual(
            MomoWindowChromeLayout.sidebarControlBandHeight,
            MomoWindowChromeLayout.controlBandHeight
        )
        XCTAssertEqual(MomoWindowChromeLayout.sidebarHeaderLeadingInset, 16)
        XCTAssertEqual(MomoWindowChromeLayout.sidebarHeaderTrailingInset, 16)
    }

    func testSidebarToggleHasExactlyOnePlacementAcrossShellStates() {
        for hasSelectedChannel in [false, true] {
            XCTAssertFalse(MomoSidebarTogglePlacementPolicy.showsInChannelHeader(
                sidebarVisible: true,
                destination: .channel,
                hasSelectedChannel: hasSelectedChannel
            ))
            XCTAssertTrue(MomoSidebarTogglePlacementPolicy.showsInChannelHeader(
                sidebarVisible: false,
                destination: .channel,
                hasSelectedChannel: hasSelectedChannel
            ))
            XCTAssertFalse(MomoSidebarTogglePlacementPolicy.showsInDetailChrome(
                sidebarVisible: false,
                destination: .channel
            ))
        }

        XCTAssertFalse(MomoSidebarTogglePlacementPolicy.showsInChannelHeader(
            sidebarVisible: false,
            destination: .plugins,
            hasSelectedChannel: true
        ))
        XCTAssertTrue(MomoSidebarTogglePlacementPolicy.showsInDetailChrome(
            sidebarVisible: false,
            destination: .plugins
        ))
    }

    func testCustomSidebarWidthStaysWithinStableBounds() {
        XCTAssertEqual(MomoWindowChromeLayout.sidebarWidth(availableWidth: 600), 240)
        XCTAssertEqual(MomoWindowChromeLayout.sidebarWidth(availableWidth: 1_200), 280)
        XCTAssertEqual(MomoWindowChromeLayout.sidebarWidth(availableWidth: 2_000), 280)
        XCTAssertEqual(
            MomoWindowChromeLayout.sidebarWidth(preferredWidth: 360, availableWidth: 1_200),
            360
        )
        XCTAssertEqual(
            MomoWindowChromeLayout.sidebarWidth(preferredWidth: 500, availableWidth: 760),
            240
        )
    }

    func testWindowChromeMetricsMeasureContentLayoutBandInContentViewCoordinates() {
        XCTAssertEqual(
            MomoWindowChromeMetrics.measure(
                contentViewBounds: CGRect(x: 0, y: 0, width: 1_180, height: 760),
                contentLayoutRect: CGRect(x: 0, y: 0, width: 1_180, height: 694),
                contentViewIsFlipped: false
            ).topInset,
            66
        )
        XCTAssertEqual(
            MomoWindowChromeMetrics.measure(
                contentViewBounds: CGRect(x: 0, y: 0, width: 1_180, height: 726),
                contentLayoutRect: CGRect(x: 0, y: 0, width: 1_180, height: 726),
                contentViewIsFlipped: false
            ).topInset,
            0
        )
        XCTAssertEqual(
            MomoWindowChromeMetrics.measure(
                contentViewBounds: CGRect(x: 0, y: 0, width: 1_180, height: 760),
                contentLayoutRect: CGRect(x: 0, y: 52, width: 1_180, height: 708),
                contentViewIsFlipped: true
            ).topInset,
            52
        )
    }

    func testTrafficLightAlignmentUsesMeasuredChromeAndHeaderGeometry() {
        XCTAssertEqual(
            MomoWindowChromeStyle.trafficLightTargetCenterYFromTop(
                windowChromeTopInset: 52,
                headerBandHeight: MomoWindowChromeLayout.integratedHeaderHeight
            ),
            52
        )
        XCTAssertEqual(
            MomoWindowChromeLayout.centerHeaderLeadingInset(
                sidebarVisible: false,
                trafficLightTrailingX: 136
            ) + MomoTheme.ChannelHeader.edgeInset,
            152
        )
    }

    func testFullHeightChromeAndChannelHeaderUseThinStableContracts() {
        XCTAssertFalse(MomoWindowChromeStyle.showsSystemTitle)
        XCTAssertEqual(MomoWindowChromeLayout.minimumControlBandHeight, 52)
        XCTAssertEqual(MomoTheme.ChannelHeader.minimumHeight, 48)
    }

    @MainActor
    func testFlatUnifiedChromeRemovesNativeTitlebarSeparation() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        let toolbar = NSToolbar(identifier: "MomoChannelChromeTests.toolbar")
        toolbar.showsBaselineSeparator = true
        window.toolbar = toolbar
        window.titleVisibility = .visible
        window.titlebarAppearsTransparent = false
        window.titlebarSeparatorStyle = .line

        MomoWindowChromeStyle.applyFlatUnifiedChrome(to: window)

        XCTAssertTrue(window.styleMask.contains(.fullSizeContentView))
        XCTAssertEqual(window.titleVisibility, .hidden)
        XCTAssertTrue(window.titlebarAppearsTransparent)
        XCTAssertEqual(window.titlebarSeparatorStyle, .none)
        XCTAssertNil(window.toolbar)
        XCTAssertTrue(window.isMovableByWindowBackground)
    }

    @MainActor
    func testFlatUnifiedChromeRepairsLateSceneMutationAfterAppReactivation() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        var deferredRepair: (@MainActor () -> Void)?
        MomoWindowChromeStyle.repairFlatUnifiedChromeAcrossLifecycle(to: window) { repair in
            deferredRepair = repair
        }

        // Reproduce SwiftUI restoring native scene chrome after AppKit has
        // already delivered its activation notification.
        window.titleVisibility = .visible
        window.titlebarAppearsTransparent = false
        window.titlebarSeparatorStyle = .line
        window.toolbar = NSToolbar(identifier: "MomoChannelChromeTests.reactivation")
        window.isMovableByWindowBackground = false

        XCTAssertNotNil(deferredRepair)
        deferredRepair?()

        XCTAssertTrue(window.styleMask.contains(.fullSizeContentView))
        XCTAssertEqual(window.titleVisibility, .hidden)
        XCTAssertTrue(window.titlebarAppearsTransparent)
        XCTAssertEqual(window.titlebarSeparatorStyle, .none)
        XCTAssertNil(window.toolbar)
        XCTAssertTrue(window.isMovableByWindowBackground)
    }

    @MainActor
    func testFlatUnifiedChromePreservesInteractiveContentHitTesting() {
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 800, height: 600))
        let button = NSButton(frame: NSRect(x: 40, y: 40, width: 120, height: 32))
        content.addSubview(button)
        let window = NSWindow(
            contentRect: content.bounds,
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.contentView = content

        MomoWindowChromeStyle.applyFlatUnifiedChrome(to: window)

        XCTAssertTrue(content.hitTest(NSPoint(x: 80, y: 56)) === button)
        XCTAssertTrue(content.hitTest(NSPoint(x: 400, y: 300)) === content)
    }

    func testChannelQuickActionsAreLimitedToSelectionOrHover() {
        XCTAssertFalse(
            MomoChannelRowActionVisibility.isVisible(isSelected: false, isHovered: false)
        )
        XCTAssertTrue(
            MomoChannelRowActionVisibility.isVisible(isSelected: true, isHovered: false)
        )
        XCTAssertTrue(
            MomoChannelRowActionVisibility.isVisible(isSelected: false, isHovered: true)
        )
    }

    func testOnlyActivePublicAndPrivateChannelsAllowMembershipManagement() {
        let workspace = WorkspaceID()
        XCTAssertTrue(MomoChannelActionPolicy.canManageMembers(in: Channel(
            id: ChannelID(), workspaceId: workspace, kind: .publicChannel
        )))
        XCTAssertTrue(MomoChannelActionPolicy.canManageMembers(in: Channel(
            id: ChannelID(), workspaceId: workspace, kind: .privateChannel
        )))
        XCTAssertFalse(MomoChannelActionPolicy.canManageMembers(in: Channel(
            id: ChannelID(), workspaceId: workspace, kind: .dm
        )))
        XCTAssertFalse(MomoChannelActionPolicy.canManageMembers(in: Channel(
            id: ChannelID(),
            workspaceId: workspace,
            kind: .publicChannel,
            archivedAtMs: 1
        )))
        XCTAssertFalse(MomoChannelActionPolicy.canManageMembers(
            in: Channel(id: ChannelID(), workspaceId: workspace, kind: .publicChannel),
            canManageWorkspace: false
        ))
        XCTAssertFalse(MomoChannelActionPolicy.canOpenSettings(in: Channel(
            id: ChannelID(), workspaceId: workspace, kind: .dm
        )))
    }

    func testSearchAndDownloadCopyDescribeCurrentCapabilities() {
        let korean = MomoWorkspaceCopy(language: .korean)
        let english = MomoWorkspaceCopy(language: .english)

        XCTAssertTrue(korean.workspaceSearchUnavailableDetail.contains("서버 메시지 검색이 없습니다"))
        XCTAssertTrue(english.workspaceSearchUnavailableDetail.contains("does not include server message search"))
        XCTAssertTrue(korean.downloadsScopeNote.contains("채팅 첨부파일"))
        XCTAssertTrue(english.downloadsScopeNote.contains("attachment downloads will appear"))
        XCTAssertTrue(korean.downloadsSubtitle.contains("지원 후 표시될"))
        XCTAssertTrue(english.downloadsSubtitle.contains("will appear when file transfer is available"))
        XCTAssertEqual(korean.approveAll, "모두 승인")
        XCTAssertEqual(english.approveAll, "Approve all")
        XCTAssertEqual(korean.alwaysApprove, "항상 승인")
        XCTAssertEqual(english.alwaysApprove, "Always approve")
        XCTAssertTrue(korean.alwaysApproveScope.contains("되돌릴 수 있는 요청만"))
        XCTAssertTrue(english.alwaysApproveScope.contains("Only reversible requests"))
    }

    func testAutomaticApprovalOnlyAcceptsExplicitlyReversibleRequests() {
        func approval(isReversible: Bool?) -> ApprovalEvent {
            ApprovalEvent(
                action: .requested,
                approvalId: ApprovalID(),
                runId: RunID(),
                channelId: ChannelID(),
                requestedBy: MemberID(),
                actionType: "github.issue.create",
                status: .pending,
                isReversible: isReversible
            )
        }

        let reversible = approval(isReversible: true)
        let irreversible = approval(isReversible: false)
        let unknownRisk = approval(isReversible: nil)

        XCTAssertTrue(MomoAutomaticApprovalPolicy.isEligibleForAutomaticApproval(reversible))
        XCTAssertFalse(MomoAutomaticApprovalPolicy.requiresBatchConfirmation(reversible))
        XCTAssertFalse(MomoAutomaticApprovalPolicy.isEligibleForAutomaticApproval(irreversible))
        XCTAssertTrue(MomoAutomaticApprovalPolicy.requiresBatchConfirmation(irreversible))
        XCTAssertFalse(MomoAutomaticApprovalPolicy.isEligibleForAutomaticApproval(unknownRisk))
        XCTAssertTrue(MomoAutomaticApprovalPolicy.requiresBatchConfirmation(unknownRisk))
    }

    func testDownloadFolderUsesUserSelectedReadWriteSandboxEntitlement() throws {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let entitlements = try String(
            contentsOf: packageRoot.appendingPathComponent("XcodeHost/MomoMac.entitlements"),
            encoding: .utf8
        )

        XCTAssertTrue(entitlements.contains("com.apple.security.files.user-selected.read-write"))
        XCTAssertTrue(entitlements.contains("com.apple.security.files.bookmarks.app-scope"))
    }

    func testDownloadHistoryStorePersistsCapsAndRemovesManagedRecords() throws {
        let suiteName = "MomoChannelChromeTests.downloads.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let old = MomoDownloadHistoryRecord(
            fileName: "old.txt",
            filePath: "/tmp/momo/old.txt",
            recordedAt: Date(timeIntervalSince1970: 1),
            outcome: .completed
        )
        let recent = MomoDownloadHistoryRecord(
            fileName: "recent.txt",
            filePath: "/tmp/momo/recent.txt",
            recordedAt: Date(timeIntervalSince1970: 2),
            outcome: .failed
        )

        MomoDownloadHistoryStore.record(old, defaults: defaults)
        MomoDownloadHistoryStore.record(recent, defaults: defaults)
        XCTAssertEqual(MomoDownloadHistoryStore.load(defaults: defaults), [recent, old])

        MomoDownloadHistoryStore.remove(recent.id, defaults: defaults)
        XCTAssertEqual(MomoDownloadHistoryStore.load(defaults: defaults), [old])

        for index in 0..<(MomoDownloadHistoryStore.maximumRecordCount + 5) {
            MomoDownloadHistoryStore.record(
                MomoDownloadHistoryRecord(
                    fileName: "file-\(index).txt",
                    filePath: "/tmp/momo/file-\(index).txt",
                    recordedAt: Date(timeIntervalSince1970: TimeInterval(index + 10)),
                    outcome: .completed
                ),
                defaults: defaults
            )
        }
        XCTAssertEqual(
            MomoDownloadHistoryStore.load(defaults: defaults).count,
            MomoDownloadHistoryStore.maximumRecordCount
        )
    }

    func testDownloadFileBoundaryRejectsOutsidePrefixAndEscapingSymlink() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appendingPathComponent("momo-download-boundary-\(UUID().uuidString)", isDirectory: true)
        let downloads = root.appendingPathComponent("Downloads", isDirectory: true)
        let prefixCollision = root.appendingPathComponent("Downloads-other", isDirectory: true)
        let outside = root.appendingPathComponent("outside", isDirectory: true)
        try fileManager.createDirectory(at: downloads, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: prefixCollision, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: outside, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: root) }

        let siblingFile = prefixCollision.appendingPathComponent("report.txt")
        let outsideFile = outside.appendingPathComponent("secret.txt")
        let directoryRecord = downloads.appendingPathComponent("nested", isDirectory: true)
        try Data("sibling".utf8).write(to: siblingFile)
        try Data("outside".utf8).write(to: outsideFile)
        try fileManager.createDirectory(at: directoryRecord, withIntermediateDirectories: true)
        let escapingLink = downloads.appendingPathComponent("outside-link")
        try fileManager.createSymbolicLink(at: escapingLink, withDestinationURL: outside)
        let finalLink = downloads.appendingPathComponent("final-link.txt")
        try fileManager.createSymbolicLink(at: finalLink, withDestinationURL: outsideFile)

        XCTAssertNil(
            MomoDownloadFileBoundary.managedFileURL(
                recordPath: siblingFile.path,
                downloadsFolder: downloads
            )
        )
        XCTAssertNil(
            MomoDownloadFileBoundary.managedFileURL(
                recordPath: escapingLink.appendingPathComponent("secret.txt").path,
                downloadsFolder: downloads
            )
        )
        XCTAssertNil(
            MomoDownloadFileBoundary.managedFileURL(
                recordPath: finalLink.path,
                downloadsFolder: downloads
            )
        )
        XCTAssertNil(
            MomoDownloadFileBoundary.managedFileURL(
                recordPath: directoryRecord.path,
                downloadsFolder: downloads
            )
        )
        XCTAssertTrue(fileManager.fileExists(atPath: outsideFile.path))
    }

    func testDownloadDeleteKeepsHistoryOnFailureAndRemovesItAfterSuccess() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory
            .appendingPathComponent("momo-download-delete-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: root) }

        let suiteName = "MomoChannelChromeTests.downloadDelete.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let missingRecord = MomoDownloadHistoryRecord(
            fileName: "missing.txt",
            filePath: root.appendingPathComponent("missing.txt").path,
            outcome: .completed
        )
        MomoDownloadHistoryStore.record(missingRecord, defaults: defaults)

        XCTAssertFalse(
            MomoDownloadFileBoundary.delete(
                record: missingRecord,
                downloadsFolder: root,
                defaults: defaults,
                fileManager: fileManager
            )
        )
        XCTAssertEqual(MomoDownloadHistoryStore.load(defaults: defaults), [missingRecord])

        let fileURL = root.appendingPathComponent("completed.txt")
        try Data("completed".utf8).write(to: fileURL)
        let completedRecord = MomoDownloadHistoryRecord(
            fileName: fileURL.lastPathComponent,
            filePath: fileURL.path,
            outcome: .completed
        )
        MomoDownloadHistoryStore.record(completedRecord, defaults: defaults)

        XCTAssertTrue(
            MomoDownloadFileBoundary.delete(
                record: completedRecord,
                downloadsFolder: root,
                defaults: defaults,
                fileManager: fileManager
            )
        )
        XCTAssertFalse(fileManager.fileExists(atPath: fileURL.path))
        XCTAssertFalse(MomoDownloadHistoryStore.load(defaults: defaults).contains(completedRecord))
    }

    func testChannelPresentationNormalizesNameAndOptionalTopic() throws {
        let presentation = try XCTUnwrap(
            MomoChannelPresentation(name: "  design-system  ", topic: "  하나의 타임라인, two densities  ").normalized
        )

        XCTAssertEqual(presentation.name, "design-system")
        XCTAssertEqual(presentation.topic, "하나의 타임라인, two densities")
        XCTAssertNil(MomoChannelPresentation(name: "   ", topic: nil).normalized)
        XCTAssertNil(
            MomoChannelPresentation(
                name: String(repeating: "a", count: MomoChannelPresentation.maximumNameLength + 1),
                topic: nil
            ).normalized
        )
        XCTAssertNil(
            MomoChannelPresentation(
                name: "general",
                topic: String(repeating: "가", count: MomoChannelPresentation.maximumTopicLength + 1)
            ).normalized
        )
    }

    func testMemberDirectoryHookDispatchesExactlyOnce() {
        var invocationCount = 0
        let hook: MomoMemberDirectoryHook = {
            invocationCount += 1
        }

        hook()

        XCTAssertEqual(invocationCount, 1)
    }

    func testMemberDirectoryNavigationUsesProductionSheetFallback() {
        var presentationCount = 0
        let action = MomoMemberDirectoryNavigation.action(
            override: nil,
            presentDirectory: {
                presentationCount += 1
            }
        )

        action()

        XCTAssertEqual(presentationCount, 1)
    }

    func testMemberDirectoryNavigationPreservesInjectedOverride() {
        var overrideCount = 0
        var presentationCount = 0
        let action = MomoMemberDirectoryNavigation.action(
            override: {
                overrideCount += 1
            },
            presentDirectory: {
                presentationCount += 1
            }
        )

        action()

        XCTAssertEqual(overrideCount, 1)
        XCTAssertEqual(presentationCount, 0)
    }

    func testLocalChannelPresentationDrivesSharedDisplayResolvers() throws {
        let channelID = ChannelID()
        let channel = Channel(
            id: channelID,
            workspaceId: WorkspaceID(),
            kind: .publicChannel,
            name: "canonical-name",
            topic: "Canonical topic"
        )
        let nameKey = "momo.channel.\(channelID.description).displayName"
        let topicKey = "momo.channel.\(channelID.description).topic"
        defer {
            UserDefaults.standard.removeObject(forKey: nameKey)
            UserDefaults.standard.removeObject(forKey: topicKey)
        }

        MomoLocalChannelPresentationStore.save(
            MomoChannelPresentation(name: "renamed-channel", topic: "Local topic"),
            for: channel
        )

        XCTAssertEqual(MomoLocalChannelPresentationStore.displayName(for: channel), "renamed-channel")
        XCTAssertEqual(
            MomoChannelDisplayPolicy.name(
                for: channel,
                members: [],
                currentMemberID: nil
            ),
            "renamed-channel"
        )
        let item = try XCTUnwrap(
            MomoQuickSwitcherSearch.sections(
                orderedChannels: [channel],
                members: [],
                searchableMembers: [],
                currentMemberID: nil,
                recentChannelIds: [],
                query: "renamed"
            )
            .flatMap(\.items)
            .first
        )
        XCTAssertEqual(item.title, "#renamed-channel")
        XCTAssertEqual(item.subtitle, "Local topic")
    }
}
