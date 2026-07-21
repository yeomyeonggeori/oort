#if os(iOS)
import MomoCore
import SwiftUI

struct IOSMessageArtifactCard: View {
    let presentation: MessageArtifactPresentation

    var body: some View {
        GroupBox {
            switch presentation {
            case .diff(let diff):
                diffCard(diff)
            case .link(let artifact):
                linkCard(artifact)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func diffCard(_ diff: UnifiedDiffPresentation) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Label(diff.title, systemImage: "doc.text.magnifyingglass")
                    .font(.subheadline.weight(.semibold))
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
                    .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
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
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                Spacer(minLength: 8)
                Text(artifact.kind == .commit ? "COMMIT" : "PR")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
            }

            if let repository = artifact.repository {
                metadataLabel(repository, systemImage: "shippingbox")
            }
            if let branch = artifact.branch {
                metadataLabel(branch, systemImage: "arrow.triangle.branch")
            }
            if let status = artifact.status {
                metadataLabel(status, systemImage: "circle.fill")
            }

            if let url = artifact.url {
                Link(destination: url) {
                    Label("Open in browser", systemImage: "arrow.up.right.square")
                        .frame(minHeight: 44)
                }
                .accessibilityLabel("Open \(artifact.title) in browser")
            }
        }
        .accessibilityLabel(linkAccessibilityLabel(artifact))
    }

    private func metadataLabel(_ value: String, systemImage: String) -> some View {
        Label(value, systemImage: systemImage)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
    }

    private func changeSummary(additions: Int, deletions: Int) -> some View {
        HStack(spacing: 4) {
            Text("+\(additions)")
                .foregroundStyle(.green)
            Text("−\(deletions)")
                .foregroundStyle(.red)
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
        case .addition: .green
        case .deletion: .red
        case .hunk: .blue
        case .metadata: .secondary
        case .context: .primary
        }
    }

    private func lineBackground(_ kind: UnifiedDiffLine.Kind) -> Color {
        switch kind {
        case .addition: Color.green.opacity(0.08)
        case .deletion: Color.red.opacity(0.08)
        case .hunk: Color.blue.opacity(0.06)
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
#endif
