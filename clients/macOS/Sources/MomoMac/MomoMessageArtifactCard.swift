import MomoCore
import SwiftUI

struct MomoMessageArtifactCard: View {
    let presentation: MessageArtifactPresentation
    var copy = MomoWorkspaceCopy(language: .preferredDefault)

    @State private var isExpanded = false
    @State private var showsRawPayload = false

    /// Diff bodies scroll inside this fixed height so a long change never grows
    /// the timeline row or pushes the window into horizontal page scroll.
    private static let bodyMaxHeight: CGFloat = 400

    var body: some View {
        Group {
            switch presentation {
            case .diff(let diff):
                diffCard(diff)
            case .link(let artifact):
                linkCard(artifact)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .momoSurface(.card, cornerRadius: MomoTheme.bubbleCorner)
        .accessibilityElement(children: .contain)
    }

    private func diffCard(_ diff: UnifiedDiffPresentation) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Label(diff.title, systemImage: "doc.text.magnifyingglass")
                    .font(.callout.weight(.semibold))
                    .lineLimit(2)
                Spacer(minLength: 8)
                changeSummary(additions: diff.additions, deletions: diff.deletions)
            }

            if diff.isTruncated {
                truncationBanner(diff)
            }

            MomoDiffBodyView(files: diff.files, maxHeight: Self.bodyMaxHeight)

            HStack(spacing: 12) {
                Button {
                    isExpanded = true
                } label: {
                    Label(copy.diffExpandAction, systemImage: "arrow.up.left.and.arrow.down.right")
                }
                .buttonStyle(.link)
                .accessibilityLabel(copy.diffExpandAccessibility(title: diff.title))

                Spacer(minLength: 8)
            }

            rawPayloadDisclosure(diff)
        }
        .accessibilityLabel(diffAccessibilityLabel(diff))
        .sheet(isPresented: $isExpanded) {
            MomoDiffExpandedView(diff: diff, copy: copy)
        }
    }

    private func truncationBanner(_ diff: UnifiedDiffPresentation) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "info.circle")
            Text(copy.diffTruncationBanner(total: diff.totalLineCount, shown: diff.displayedLineCount))
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.caption.monospacedDigit())
        .foregroundStyle(.secondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Color.primary.opacity(0.04),
            in: RoundedRectangle(cornerRadius: MomoTheme.cornerSmall)
        )
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func rawPayloadDisclosure(_ diff: UnifiedDiffPresentation) -> some View {
        DisclosureGroup(isExpanded: $showsRawPayload) {
            ScrollView([.vertical, .horizontal]) {
                Text(diff.rawPatch.isEmpty ? " " : diff.rawPatch)
                    .font(.caption.monospaced())
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .fixedSize()
                    .padding(8)
            }
            .frame(maxHeight: 240)
            .scrollIndicators(.visible)
            .background(
                Color.primary.opacity(0.025),
                in: RoundedRectangle(cornerRadius: MomoTheme.cornerSmall)
            )
        } label: {
            Text(copy.diffRawLabel)
                .font(.caption.weight(.medium))
        }
    }

    private func diffAccessibilityLabel(_ diff: UnifiedDiffPresentation) -> String {
        "\(diff.title), \(diff.files.count) files, \(diff.additions) additions, \(diff.deletions) deletions"
    }

    private func linkCard(_ artifact: ArtifactLinkPresentation) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Label(artifact.title, systemImage: artifact.kind == .commit ? "arrow.triangle.branch" : "point.3.connected.trianglepath.dotted")
                    .font(.callout.weight(.semibold))
                    .lineLimit(2)
                Spacer(minLength: 8)
                Text(artifact.kind == .commit ? "COMMIT" : "PR")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
            }

            if artifact.branch != nil || artifact.status != nil || artifact.repository != nil {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) { linkMetadata(artifact) }
                    VStack(alignment: .leading, spacing: 4) { linkMetadata(artifact) }
                }
            }

            if let url = artifact.url {
                Link(destination: url) {
                    Label("Open in browser", systemImage: "arrow.up.right.square")
                }
                .buttonStyle(.link)
                .accessibilityLabel("Open \(artifact.title) in browser")
            }
        }
        .accessibilityLabel(linkAccessibilityLabel(artifact))
    }

    @ViewBuilder
    private func linkMetadata(_ artifact: ArtifactLinkPresentation) -> some View {
        if let repository = artifact.repository {
            Label(repository, systemImage: "shippingbox")
                .lineLimit(1)
                .truncationMode(.middle)
        }
        if let branch = artifact.branch {
            Label(branch, systemImage: "arrow.triangle.branch")
                .lineLimit(1)
                .truncationMode(.middle)
        }
        if let status = artifact.status {
            Label(status, systemImage: "circle.fill")
                .lineLimit(1)
        }
    }

    private func linkAccessibilityLabel(_ artifact: ArtifactLinkPresentation) -> String {
        [
            artifact.kind == .commit ? "Commit" : "Pull request",
            artifact.title,
            artifact.repository,
            artifact.branch,
            artifact.status,
        ]
        .compactMap { $0 }
        .joined(separator: ", ")
    }
}

// MARK: - Diff body (shared by the card and the expanded view)

/// Vertically scrolling diff body. Sizes to content up to `maxHeight`, then caps
/// and scrolls so the surrounding timeline row never grows unbounded and the
/// window never gains a horizontal page scroll.
private struct MomoDiffBodyView: View {
    let files: [UnifiedDiffFile]
    let maxHeight: CGFloat

    @State private var contentHeight: CGFloat = 0

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(files) { file in
                    MomoDiffFileSection(file: file)
                }
            }
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                GeometryReader { proxy in
                    Color.clear.preference(
                        key: MomoDiffContentHeightPreferenceKey.self,
                        value: proxy.size.height
                    )
                }
            )
        }
        .frame(height: resolvedHeight)
        .scrollIndicators(.visible)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            Color.primary.opacity(0.025),
            in: RoundedRectangle(cornerRadius: MomoTheme.cornerSmall)
        )
        .onPreferenceChange(MomoDiffContentHeightPreferenceKey.self) { contentHeight = $0 }
    }

    /// Hug the measured content height so short diffs stay tight and only genuinely
    /// long ones reach `maxHeight` and scroll. The content's natural height is
    /// independent of this viewport frame (the scroll axis is unbounded), so
    /// measuring it never feeds back into the layout. Before the first measurement
    /// lands we fall back to `maxHeight`; the snapshot host runs a second layout
    /// pass after the preference settles, so the captured frame is the hugged one.
    private var resolvedHeight: CGFloat {
        guard contentHeight > 0 else { return maxHeight }
        return min(contentHeight, maxHeight)
    }
}

private struct MomoDiffContentHeightPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// One file inside a diff: a path header that stays readable when truncated,
/// then the file's lines in a horizontal scroll so long lines never widen the page.
private struct MomoDiffFileSection: View {
    let file: UnifiedDiffFile

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(file.path)
                    .font(.caption.monospaced().weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                changeSummary(additions: file.additions, deletions: file.deletions)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)

            ScrollView(.horizontal) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(file.lines) { line in
                        diffLine(line)
                    }
                }
            }
            .scrollIndicators(.visible)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(file.path), \(file.additions) additions, \(file.deletions) deletions")
    }
}

// MARK: - Expanded view

/// Full-window presentation of the same diff, reached from the card's Expand
/// action. Escape (`cancelAction`) closes it.
private struct MomoDiffExpandedView: View {
    let diff: UnifiedDiffPresentation
    let copy: MomoWorkspaceCopy

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Label(diff.title, systemImage: "doc.text.magnifyingglass")
                    .font(.headline)
                    .lineLimit(2)
                Spacer(minLength: 12)
                changeSummary(additions: diff.additions, deletions: diff.deletions)
                Button(copy.diffExpandedClose) { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }

            if diff.isTruncated {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "info.circle")
                    Text(copy.diffTruncationBanner(total: diff.totalLineCount, shown: diff.displayedLineCount))
                }
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .accessibilityElement(children: .combine)
            }

            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(diff.files) { file in
                        MomoDiffFileSection(file: file)
                    }
                }
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollIndicators(.visible)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(
                Color.primary.opacity(0.025),
                in: RoundedRectangle(cornerRadius: MomoTheme.cornerSmall)
            )
        }
        .padding(16)
        .frame(minWidth: 640, idealWidth: 760, minHeight: 480, idealHeight: 620)
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Shared row rendering

private func changeSummary(additions: Int, deletions: Int) -> some View {
    HStack(spacing: 4) {
        Text("+\(additions)")
            .foregroundStyle(MomoTheme.reversibleGreen)
        Text("−\(deletions)")
            .foregroundStyle(MomoTheme.irreversibleRed)
    }
    .font(.caption.monospacedDigit().weight(.semibold))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(additions) additions, \(deletions) deletions")
}

private func diffLine(_ line: UnifiedDiffLine) -> some View {
    Text(line.text.isEmpty ? " " : line.text)
        .font(.caption.monospaced())
        .foregroundStyle(lineForeground(line.kind))
        .textSelection(.enabled)
        .padding(.horizontal, 8)
        .frame(minWidth: 240, maxWidth: .infinity, alignment: .leading)
        .background(lineBackground(line.kind))
        .accessibilityLabel(lineAccessibilityLabel(line))
}

private func lineForeground(_ kind: UnifiedDiffLine.Kind) -> Color {
    switch kind {
    case .addition: MomoTheme.reversibleGreen
    case .deletion: MomoTheme.irreversibleRed
    case .hunk: MomoTheme.humanAccent
    case .metadata: .secondary
    case .context: .primary
    }
}

private func lineBackground(_ kind: UnifiedDiffLine.Kind) -> Color {
    switch kind {
    case .addition: MomoTheme.reversibleGreen.opacity(0.08)
    case .deletion: MomoTheme.irreversibleRed.opacity(0.08)
    case .hunk: MomoTheme.humanAccent.opacity(0.06)
    case .metadata, .context: .clear
    }
}

private func lineAccessibilityLabel(_ line: UnifiedDiffLine) -> String {
    let prefix: String
    switch line.kind {
    case .addition: prefix = "Added"
    case .deletion: prefix = "Deleted"
    case .hunk: prefix = "Change section"
    case .metadata: prefix = "Diff metadata"
    case .context: prefix = "Context"
    }
    return "\(prefix): \(line.text)"
}
