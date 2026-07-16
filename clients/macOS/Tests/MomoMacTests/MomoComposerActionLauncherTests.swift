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

        XCTAssertEqual(korean.title(for: .fileUpload), "파일 업로드")
        XCTAssertEqual(korean.title(for: .addPlugin), "플러그인 추가")
        XCTAssertEqual(english.title(for: .startWork), "Start new work")
        XCTAssertEqual(english.title(for: .createPoll), "Create poll")
    }

    func testAttachmentDraftMergeAcceptsFilesAndDeduplicatesStandardizedURLs() {
        let first = URL(fileURLWithPath: "/tmp/momo-composer/report.pdf")
        let duplicate = URL(fileURLWithPath: "/tmp/momo-composer/./report.pdf")
        let second = URL(fileURLWithPath: "/tmp/momo-composer/demo.mov")
        let remote = URL(string: "https://example.com/not-a-local-file")!

        let drafts = MomoAttachmentDraftCollection.merging(
            [],
            urls: [first, duplicate, remote, second]
        )

        XCTAssertEqual(drafts.map(\.name), ["report.pdf", "demo.mov"])
        XCTAssertEqual(drafts.map(\.systemImage), ["doc.richtext", "video"])
    }
}
