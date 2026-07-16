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
        XCTAssertTrue(korean.connectionPending.contains("로컬 미리보기"))
        XCTAssertTrue(english.connectionPending.contains("local preview"))
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
    }
}
