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
        XCTAssertFalse(
            ApprovalInboxView(
                viewModel: viewModel,
                inspectorPresentation: .overlay
            ).ownsInspectorSurface
        )
    }

    func testAttachedInspectorUsesFlatSurfaceWhileOverlayKeepsElevatedChrome() {
        XCTAssertFalse(MomoInspectorPresentation.attached.usesElevatedSurfaceChrome)
        XCTAssertTrue(MomoInspectorPresentation.overlay.usesElevatedSurfaceChrome)
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

    func testSafeDetailViewportAndInspectorRespectTheirTopBoundaries() {
        XCTAssertEqual(MomoWindowChromeLayout.contentTopInset(windowChromeTopInset: 52), 0)
        XCTAssertEqual(MomoWindowChromeLayout.contentTopInset(windowChromeTopInset: -1), 0)
        XCTAssertEqual(
            MomoWindowChromeLayout.inspectorTopInset(
                channelHeaderHeight: 84
            ),
            84
        )
        XCTAssertEqual(
            MomoWindowChromeLayout.inspectorTopInset(
                channelHeaderHeight: -1
            ),
            0
        )
    }

    func testNativeSidebarDoesNotApplyWindowChromeInsetTwice() {
        XCTAssertEqual(
            MomoWindowChromeLayout.sidebarTopInset(
                windowChromeTopInset: 52
            ),
            0
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

    func testCompactChromeAndChannelHeaderUseThinStableContracts() {
        XCTAssertEqual(MomoWindowChromeStyle.appKitToolbarStyle, .unifiedCompact)
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
        window.titlebarAppearsTransparent = false
        window.titlebarSeparatorStyle = .line

        MomoWindowChromeStyle.applyFlatUnifiedChrome(to: window)

        XCTAssertTrue(window.titlebarAppearsTransparent)
        XCTAssertEqual(window.titlebarSeparatorStyle, .none)
        XCTAssertFalse(try XCTUnwrap(window.toolbar).showsBaselineSeparator)
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
