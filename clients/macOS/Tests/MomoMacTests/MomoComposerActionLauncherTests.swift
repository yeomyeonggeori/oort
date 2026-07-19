import XCTest
@testable import MomoMac

final class MomoComposerActionLauncherTests: XCTestCase {
    func testLauncherExposesEveryProductActionInStableOrder() {
        XCTAssertEqual(
            MomoComposerAction.allCases,
            [.fileUpload, .startWork, .createThread, .createPoll, .addPlugin]
        )
    }

    func testLauncherCopySupportsKoreanAndEnglish() {
        let korean = MomoComposerActionCopy(language: .korean)
        let english = MomoComposerActionCopy(language: .english)

        XCTAssertEqual(korean.title(for: .fileUpload), "파일 첨부")
        XCTAssertEqual(korean.title(for: .addPlugin), "플러그인 둘러보기")
        XCTAssertEqual(english.title(for: .startWork), "Start new work")
        XCTAssertEqual(english.title(for: .createPoll), "Poll draft")
        XCTAssertTrue(korean.connectionPending.contains("100MB"))
        XCTAssertTrue(english.connectionPending.contains("100 MB"))
    }

    func testAttachmentDraftMergeAcceptsFilesAndDeduplicatesStandardizedURLs() {
        let first = URL(fileURLWithPath: "/tmp/momo-composer/report.pdf")
        let duplicate = URL(fileURLWithPath: "/tmp/momo-composer/./report.pdf")
        let second = URL(fileURLWithPath: "/tmp/momo-composer/demo.mov")
        let directory = URL(fileURLWithPath: "/tmp/momo-composer/folder", isDirectory: true)
        let remote = URL(string: "https://example.com/not-a-local-file")!

        let drafts = MomoAttachmentDraftCollection.merging(
            [],
            urls: [first, duplicate, directory, remote, second]
        )

        XCTAssertEqual(drafts.map(\.name), ["report.pdf", "demo.mov"])
        XCTAssertEqual(drafts.map(\.systemImage), ["doc.richtext", "video"])
        XCTAssertTrue(drafts.allSatisfy { $0.state == .ready })
    }

    func testAttachmentDraftMergeCapsServerContractAtTwentyFiles() {
        let urls = (0..<25).map {
            URL(fileURLWithPath: "/tmp/momo-composer/file-\($0).txt")
        }

        let drafts = MomoAttachmentDraftCollection.merging([], urls: urls)

        XCTAssertEqual(drafts.count, 20)
        XCTAssertEqual(drafts.last?.name, "file-19.txt")
    }

    func testAttachmentDownloadDestinationSanitizesLeafAndAvoidsCollision() throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let first = folder.appendingPathComponent("report.pdf")
        FileManager.default.createFile(atPath: first.path, contents: Data())

        let destination = try MomoAttachmentFileBoundary.destinationURL(
            named: "../report.pdf",
            in: folder
        )

        XCTAssertEqual(destination.lastPathComponent, "report (2).pdf")
        XCTAssertEqual(destination.deletingLastPathComponent().standardizedFileURL, folder.standardizedFileURL)
    }

    func testRecommendedPluginCatalogHasStableUniqueEntriesAndCategories() {
        let plugins = MomoPluginCatalogItem.recommended

        XCTAssertEqual(
            plugins.map(\.id),
            ["google-drive", "google-calendar", "gmail", "github", "notion"]
        )
        XCTAssertEqual(Set(plugins.map(\.id)).count, plugins.count)
        XCTAssertTrue(plugins.allSatisfy { !$0.name.isEmpty && !$0.capabilities(for: .korean).isEmpty })
        XCTAssertTrue(plugins.contains { $0.category == .developer })
        XCTAssertTrue(plugins.contains { $0.category == .knowledge })
        XCTAssertTrue(plugins.contains { $0.isFeatured })
    }
}
