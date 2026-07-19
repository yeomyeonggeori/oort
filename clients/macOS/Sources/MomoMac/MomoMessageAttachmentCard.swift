import SwiftUI
import UniformTypeIdentifiers
import MomoCore

struct MomoMessageAttachmentList: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let attachments: [MessageAttachment]
    let downloadStates: [FileID: MomoAttachmentDownloadState]
    let copy: MomoWorkspaceCopy
    let onDownload: (MessageAttachment) -> Void
    let onOpen: (MessageAttachment) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: MomoTheme.Attachment.standardSpacing) {
            ForEach(attachments) { attachment in
                MomoMessageAttachmentCard(
                    attachment: attachment,
                    state: downloadStates[attachment.id],
                    copy: copy,
                    onDownload: { onDownload(attachment) },
                    onOpen: { onOpen(attachment) }
                )
            }
        }
        .frame(
            maxWidth: dynamicTypeSize.isAccessibilitySize
                ? .infinity
                : MomoTheme.Attachment.maximumWidth,
            alignment: .leading
        )
    }
}

private struct MomoMessageAttachmentCard: View {
    let attachment: MessageAttachment
    let state: MomoAttachmentDownloadState?
    let copy: MomoWorkspaceCopy
    let onDownload: () -> Void
    let onOpen: () -> Void

    var body: some View {
        HStack(spacing: MomoTheme.Attachment.contentSpacing) {
            Image(systemName: systemImage)
                .font(.title3)
                .foregroundStyle(MomoTheme.humanAccent)
                .frame(
                    width: MomoTheme.Attachment.iconSize,
                    height: MomoTheme.Attachment.iconSize
                )
                .background(
                    MomoTheme.humanAccent.opacity(0.10),
                    in: RoundedRectangle(cornerRadius: MomoTheme.cornerSmall)
                )

            VStack(alignment: .leading, spacing: MomoTheme.Attachment.compactSpacing) {
                Text(attachment.name)
                    .font(MomoTheme.Typography.supporting.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .truncationMode(.middle)
                    .help(attachment.name)
                Text(metadata)
                    .font(MomoTheme.Typography.metadata)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: MomoTheme.Attachment.standardSpacing)
            action
        }
        .padding(MomoTheme.Attachment.contentSpacing)
        .frame(minWidth: MomoTheme.Attachment.minimumWidth, alignment: .leading)
        .momoSurface(.card, cornerRadius: MomoTheme.cornerMedium)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var action: some View {
        switch state {
        case .downloading:
            ProgressView()
                .controlSize(.small)
                .frame(
                    width: MomoTheme.Attachment.actionSize,
                    height: MomoTheme.Attachment.actionSize
                )
                .accessibilityLabel(copy.attachmentDownloading)
        case .completed:
            Button(action: onOpen) {
                Image(systemName: "arrow.up.forward.app")
                    .frame(
                        width: MomoTheme.Attachment.actionSize,
                        height: MomoTheme.Attachment.actionSize
                    )
            }
            .buttonStyle(.plain)
            .momoQuickTooltip(copy.openAttachment)
            .accessibilityLabel(copy.openAttachment)
        case .failed:
            Button(action: onDownload) {
                Image(systemName: "arrow.clockwise")
                    .frame(
                        width: MomoTheme.Attachment.actionSize,
                        height: MomoTheme.Attachment.actionSize
                    )
            }
            .buttonStyle(.plain)
            .foregroundStyle(MomoTheme.irreversibleRed)
            .momoQuickTooltip(copy.retryAttachmentDownload)
            .accessibilityLabel(copy.retryAttachmentDownload)
        case nil:
            Button(action: onDownload) {
                Image(systemName: "arrow.down.to.line")
                    .frame(
                        width: MomoTheme.Attachment.actionSize,
                        height: MomoTheme.Attachment.actionSize
                    )
            }
            .buttonStyle(.plain)
            .momoQuickTooltip(copy.downloadAttachment)
            .accessibilityLabel(copy.downloadAttachment)
        }
    }

    private var metadata: String {
        let size = ByteCountFormatter.string(fromByteCount: attachment.sizeBytes, countStyle: .file)
        let type = UTType(mimeType: attachment.mime)?.localizedDescription ?? attachment.mime
        if state == .failed {
            return "\(copy.attachmentDownloadFailed) · \(size)"
        }
        return "\(type) · \(size)"
    }

    private var systemImage: String {
        guard let type = UTType(mimeType: attachment.mime) else { return "doc" }
        if type.conforms(to: .image) { return "photo" }
        if type.conforms(to: .movie) { return "video" }
        if type.conforms(to: .audio) { return "waveform" }
        if type.conforms(to: .pdf) { return "doc.richtext" }
        if type.conforms(to: .archive) { return "archivebox" }
        return "doc"
    }
}
