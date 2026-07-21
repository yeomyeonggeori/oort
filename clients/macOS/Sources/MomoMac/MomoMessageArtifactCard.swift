import MomoCore
import SwiftUI

struct MomoMessageArtifactCard: View {
    let presentation: MessageArtifactPresentation

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

            ForEach(diff.files) { file in
                DisclosureGroup {
                    ScrollView(.horizontal) {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(file.lines) { line in
                                diffLine(line)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    .scrollIndicators(.visible)
                    .background(Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: MomoTheme.cornerSmall))
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(file.path)
                            .font(.caption.monospaced().weight(.medium))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer(minLength: 8)
                        changeSummary(additions: file.additions, deletions: file.deletions)
                    }
                    .contentShape(Rectangle())
                }
                .accessibilityLabel(
                    "\(file.path), \(file.additions) additions, \(file.deletions) deletions"
                )
            }
        }
        .accessibilityLabel(
            "\(diff.title), \(diff.files.count) files, \(diff.additions) additions, \(diff.deletions) deletions"
        )
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
