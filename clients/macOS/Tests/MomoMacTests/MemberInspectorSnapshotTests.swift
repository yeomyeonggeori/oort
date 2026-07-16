import AppKit
import MomoCore
import SnapshotTesting
import SwiftUI
import XCTest
@testable import MomoMac

@MainActor
final class MemberInspectorSnapshotTests: XCTestCase {
    private func makeViewModel() async throws -> (ChatViewModel, Member) {
        let backend = LiveChatBackend()
        let seed = await backend.seedDemo()
        let viewModel = ChatViewModel(backend: backend)
        await viewModel.bootstrap(workspace: seed.workspace, accessToken: "member-inspector-snapshot")
        let channel = try XCTUnwrap(seed.channels.last)
        await viewModel.selectChannel(channel.id)
        return (viewModel, try XCTUnwrap(seed.agents.first))
    }

    private func captureProfilePopover(
        scheme: ColorScheme,
        artifactName: String
    ) async throws -> NSImage {
        guard !NSScreen.screens.isEmpty else {
            throw XCTSkip("MOMO-385 profile evidence requires a WindowServer compositor")
        }
        let (viewModel, member) = try await makeViewModel()
        let appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        let application = NSApplication.shared
        let previousApplicationAppearance = application.appearance
        application.appearance = appearance
        defer { application.appearance = previousApplicationAppearance }
        let profile = MomoMemberProfilePopoverView(
            viewModel: viewModel,
            member: member,
            copy: MomoWorkspaceCopy(language: scheme == .dark ? .english : .korean),
            showsDirectMessageFailure: false,
            copyHandle: {},
            mention: {},
            openDirectMessage: {}
        )
        .environment(\.colorScheme, scheme)
        .frame(width: MomoTheme.MemberInspector.profileWidth)

        let anchor = NSButton(title: member.displayName, target: nil, action: nil)
        anchor.frame = NSRect(x: 120, y: 254, width: 160, height: 32)
        let anchorView = NSView(frame: NSRect(x: 0, y: 0, width: 760, height: 540))
        anchorView.addSubview(anchor)
        let anchorWindow = NSWindow(
            contentRect: anchorView.bounds,
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        anchorWindow.appearance = appearance
        anchorWindow.contentView = anchorView
        anchorWindow.isReleasedWhenClosed = false
        anchorWindow.makeKeyAndOrderFront(nil)

        let popover = NSPopover()
        popover.behavior = .applicationDefined
        popover.animates = false
        popover.contentSize = NSSize(
            width: MomoTheme.MemberInspector.profileWidth,
            height: MomoTheme.MemberInspector.profileHeight
        )
        popover.contentViewController = NSHostingController(rootView: profile)
        popover.show(relativeTo: anchor.bounds, of: anchor, preferredEdge: .maxX)
        defer {
            popover.close()
            anchorWindow.close()
        }

        try await Task.sleep(for: .milliseconds(250))
        guard let profileWindow = popover.contentViewController?.view.window,
              let windowInfo = CGWindowListCopyWindowInfo(
                .optionIncludingWindow,
                CGWindowID(profileWindow.windowNumber)
              ) as? [[String: Any]],
              let boundsDictionary = windowInfo.first?[kCGWindowBounds as String] as? NSDictionary,
              let windowBounds = CGRect(dictionaryRepresentation: boundsDictionary),
              let cgImage = CGWindowListCreateImage(
                windowBounds,
                .optionOnScreenOnly,
                kCGNullWindowID,
                [.boundsIgnoreFraming, .bestResolution]
              )
        else {
            throw XCTSkip("WindowServer could not capture the MOMO-385 profile popover")
        }
        let image = NSImage(cgImage: cgImage, size: profileWindow.frame.size)
        try writeArtifact(image, named: artifactName)
        return image
    }

    private func writeArtifact(_ image: NSImage, named name: String) throws {
        guard let directory = ProcessInfo.processInfo.environment["MOMO_DESIGN_REVIEW_ARTIFACT_DIR"] else {
            return
        }
        let outputDirectory = URL(fileURLWithPath: directory, isDirectory: true)
        try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
        guard let tiff = image.tiffRepresentation,
              let representation = NSBitmapImageRep(data: tiff),
              let png = representation.representation(using: .png, properties: [:])
        else {
            throw XCTSkip("MOMO-385 profile popover could not be encoded as PNG")
        }
        try png.write(to: outputDirectory.appendingPathComponent(name), options: .atomic)
    }

    func testCompactProfilePopoverWritesLightAndDarkRealWindowArtifacts() async throws {
        let light = try await captureProfilePopover(
            scheme: .light,
            artifactName: "momo-385-profile-light.png"
        )
        let dark = try await captureProfilePopover(
            scheme: .dark,
            artifactName: "momo-385-profile-dark.png"
        )

        XCTAssertGreaterThan(light.size.width, 0)
        XCTAssertGreaterThan(light.size.height, 0)
        XCTAssertEqual(light.size, dark.size)
    }

    func testInspectorSearchReceivesInitialKeyboardFocusInRealWindow() async throws {
        guard !NSScreen.screens.isEmpty else {
            throw XCTSkip("MOMO-385 keyboard focus evidence requires a WindowServer compositor")
        }
        let (viewModel, _) = try await makeViewModel()
        let hostingController = NSHostingController(
            rootView: MomoChannelMemberInspectorView(
                viewModel: viewModel,
                audience: .channel,
                copy: MomoWorkspaceCopy(language: .english),
                close: {},
                didOpenDirectMessage: {},
                presentation: .overlay
            )
            .frame(width: MomoTheme.MemberInspector.overlayWidth, height: 620)
        )
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: MomoTheme.MemberInspector.overlayWidth, height: 620),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.contentViewController = hostingController
        window.isReleasedWhenClosed = false
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }

        try await Task.sleep(for: .milliseconds(250))
        let fieldEditor = try XCTUnwrap(window.firstResponder as? NSTextView)
        let textField = try XCTUnwrap(fieldEditor.delegate as? NSTextField)
        XCTAssertEqual(textField.placeholderString, MomoWorkspaceCopy(language: .english).searchMembers)
    }

    func testComposerFocusRequestRestoresKeyboardFocusInRealWindow() async throws {
        guard !NSScreen.screens.isEmpty else {
            throw XCTSkip("MOMO-385 focus restoration evidence requires a WindowServer compositor")
        }
        let (viewModel, _) = try await makeViewModel()
        let hostingController = NSHostingController(
            rootView: MessageListView(viewModel: viewModel, focusComposerRequest: 0)
                .frame(width: 760, height: 620)
        )
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 620),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.contentViewController = hostingController
        window.isReleasedWhenClosed = false
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }

        try await Task.sleep(for: .milliseconds(150))
        hostingController.rootView = MessageListView(
            viewModel: viewModel,
            focusComposerRequest: 1
        )
        .frame(width: 760, height: 620)
        try await Task.sleep(for: .milliseconds(250))

        let fieldEditor = try XCTUnwrap(window.firstResponder as? NSTextView)
        let textField = try XCTUnwrap(fieldEditor.delegate as? NSTextField)
        XCTAssertTrue(
            [MomoUILanguage.korean, .english]
                .map { MomoWorkspaceCopy(language: $0).messagePlaceholder }
                .contains(textField.placeholderString ?? "")
        )
    }

    private func captureMentionAutocomplete(
        scheme: ColorScheme,
        artifactName: String
    ) async throws -> NSImage {
        guard !NSScreen.screens.isEmpty else {
            throw XCTSkip("MOMO-396 mention overlay evidence requires a WindowServer compositor")
        }
        let (viewModel, _) = try await makeViewModel()
        _ = try await viewModel.inviteDogfoodAgent(
            displayName: "긴 이름을 가진 Hermes Research Assistant",
            handle: "@hermes",
            avatarPath: nil
        )
        viewModel.composerDraft = "@"
        XCTAssertGreaterThan(viewModel.mentionAutocompleteCandidates().count, 0)

        let appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
        let application = NSApplication.shared
        let previousApplicationAppearance = application.appearance
        application.appearance = appearance
        defer { application.appearance = previousApplicationAppearance }
        let hostingController = NSHostingController(
            rootView: MessageListView(viewModel: viewModel, focusComposerRequest: 1)
                .frame(width: 760, height: 620)
                .environment(\.colorScheme, scheme)
        )
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 620),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.appearance = appearance
        window.contentViewController = hostingController
        window.isReleasedWhenClosed = false
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }

        try await Task.sleep(for: .milliseconds(300))
        guard let cgImage = CGWindowListCreateImage(
            .null,
            .optionIncludingWindow,
            CGWindowID(window.windowNumber),
            [.boundsIgnoreFraming, .bestResolution]
        ) else {
            throw XCTSkip("WindowServer could not capture the MOMO-396 mention overlay")
        }

        let image = NSImage(cgImage: cgImage, size: window.frame.size)
        try writeArtifact(image, named: artifactName)
        return image
    }

    func testMentionAutocompleteWritesLightAndDarkRealWindowArtifacts() async throws {
        let light = try await captureMentionAutocomplete(
            scheme: .light,
            artifactName: "momo-396-composer-mention-overlay-light.png"
        )
        let dark = try await captureMentionAutocomplete(
            scheme: .dark,
            artifactName: "momo-396-composer-mention-overlay-dark.png"
        )
        XCTAssertEqual(light.size, dark.size)
        XCTAssertEqual(light.size.width, 760)
        XCTAssertGreaterThanOrEqual(light.size.height, 620)
    }
}
