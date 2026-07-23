import SwiftUI
import MomoCore

// MARK: - Presentation model
//
// "managed by {owner}" for agent surfaces. This consumes ONLY the roster's
// existing owner read-through (`agent.owner_human_id`, exposed as
// `agentOwnerIDsByMemberID`) and the `origin` projection. It introduces no new
// server contract.
//
// Deliberately out of scope: a "Who can talk" (owner-only / anyone / allowlist)
// control. The server has no enforcement field for that yet, so a UI toggle
// would be a fake control. The contract request is back-registered in
// docs/planning/ENGINE_HANDOFF.md (X-12).

struct MomoAgentOwnerPresentation: Equatable {
    /// The managing owner and its lifecycle relationship to the workspace.
    enum Owner: Equatable {
        /// Owner resolved from the roster and still an active member.
        case active(Member)
        /// Owner resolved from the roster but not currently active (suspended/invited/deleted).
        case inactive(Member)
        /// An owner is recorded but the human is no longer in the roster (left the workspace).
        case departed
        /// No owner is recorded for this agent.
        case none
    }

    let owner: Owner
    /// Card-origin agents run behind an external A2A endpoint, not inside the workspace.
    let isExternalRuntime: Bool

    /// Whether the label has anything to render for this agent.
    var hasContent: Bool {
        if isExternalRuntime { return true }
        if case .none = owner { return false }
        return true
    }

    var resolvedOwner: Member? {
        switch owner {
        case .active(let member), .inactive(let member): return member
        case .departed, .none: return nil
        }
    }

    var isDeparted: Bool {
        if case .departed = owner { return true }
        return false
    }

    /// The owner name should read as muted when the owner cannot currently act.
    var isMuted: Bool {
        switch owner {
        case .active: return false
        case .inactive, .departed, .none: return true
        }
    }

    /// Pure resolver. Returns `nil` when there is nothing to render (a human, or
    /// an agent with neither an owner nor an external runtime).
    static func resolve(
        agent: Member,
        ownerID: MemberID?,
        ownerMember: Member?,
        origin: MomoAgentOrigin?
    ) -> MomoAgentOwnerPresentation? {
        guard agent.isAgent else { return nil }
        let isExternalRuntime = origin == .card

        let owner: Owner
        if let ownerID {
            if let ownerMember, ownerMember.id == ownerID {
                owner = ownerMember.status == .active ? .active(ownerMember) : .inactive(ownerMember)
            } else {
                owner = .departed
            }
        } else {
            owner = .none
        }

        let presentation = MomoAgentOwnerPresentation(owner: owner, isExternalRuntime: isExternalRuntime)
        return presentation.hasContent ? presentation : nil
    }
}

// MARK: - Managed-by rows

/// Renders the "Managed by {owner}" row (and, for card agents, an "external
/// runtime" row) inside an existing profile GroupBox. The owner name opens a
/// read-only owner profile popover; card agents are annotated as external
/// runtime. Every affordance is reachable by keyboard (the owner name is a
/// focusable button).
struct MomoAgentManagedByView: View {
    @ObservedObject var viewModel: ChatViewModel
    let presentation: MomoAgentOwnerPresentation
    let copy: MomoWorkspaceCopy

    @State private var showsOwnerPopover = false

    var body: some View {
        VStack(alignment: .leading, spacing: MomoTheme.MemberInspector.standardSpacing) {
            LabeledContent(copy.agentOwnerTitle) {
                ownerValue
            }
            if presentation.isExternalRuntime {
                LabeledContent(copy.agentRuntime) {
                    Text(copy.agentExternalRuntime)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityHint(copy.agentExternalRuntimeAccessibility)
            }
        }
    }

    @ViewBuilder
    private var ownerValue: some View {
        switch presentation.owner {
        case .active(let owner), .inactive(let owner):
            VStack(alignment: .trailing, spacing: MomoTheme.MemberInspector.compactSpacing) {
                ownerButton(owner)
                if presentation.isMuted {
                    Text(copy.ownerInactive)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        case .departed:
            VStack(alignment: .trailing, spacing: MomoTheme.MemberInspector.compactSpacing) {
                Text(copy.managedByFormerMember)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(copy.ownerLeftWorkspace)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(copy.managedByFormerMember), \(copy.ownerLeftWorkspace)")
        case .none:
            EmptyView()
        }
    }

    private func ownerButton(_ owner: Member) -> some View {
        Button {
            showsOwnerPopover = true
        } label: {
            Text(owner.displayName)
                .foregroundStyle(presentation.isMuted ? AnyShapeStyle(.secondary) : AnyShapeStyle(.tint))
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .buttonStyle(.plain)
        .help(copy.viewOwnerProfile)
        .accessibilityLabel(copy.managedByOwner(owner.displayName))
        .accessibilityHint(copy.viewOwnerProfile)
        .popover(isPresented: $showsOwnerPopover, arrowEdge: .bottom) {
            MomoAgentOwnerPopover(
                viewModel: viewModel,
                owner: owner,
                presentation: presentation,
                copy: copy
            )
        }
    }
}

/// Read-only profile card for an agent's owner. Reuses the roster avatar so the
/// owner's presence dot and identity read identically to the member inspector.
struct MomoAgentOwnerPopover: View {
    @ObservedObject var viewModel: ChatViewModel
    let owner: Member
    let presentation: MomoAgentOwnerPresentation
    let copy: MomoWorkspaceCopy

    var body: some View {
        VStack(alignment: .leading, spacing: MomoTheme.MemberInspector.contentSpacing) {
            HStack(alignment: .top, spacing: MomoTheme.MemberInspector.contentSpacing) {
                MomoMemberAvatarView(
                    viewModel: viewModel,
                    member: owner,
                    size: MomoTheme.MemberInspector.profileIconSize
                )
                VStack(alignment: .leading, spacing: MomoTheme.MemberInspector.compactSpacing) {
                    Text(owner.displayName)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("@\(owner.handle)")
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                    Text(copy.workspaceRoleTitle(owner.workspaceRole))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Text(copy.managedByExplanation)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            LabeledContent(copy.status) {
                Text(copy.memberStatusTitle(owner.status))
            }
            .font(.caption)

            if presentation.isMuted {
                Label(
                    presentation.isDeparted ? copy.ownerLeftWorkspace : copy.ownerInactive,
                    systemImage: "exclamationmark.circle"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(MomoTheme.MemberInspector.edgeInset)
        .frame(width: MomoTheme.MemberInspector.profileWidth, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(copy.managedByOwner(owner.displayName))
    }
}

// MARK: - Copy

extension MomoWorkspaceCopy {
    var agentOwnerTitle: String {
        language == .korean ? "관리 주체" : "Managed by"
    }

    func managedByOwner(_ name: String) -> String {
        language == .korean ? "\(name) 님이 관리" : "Managed by \(name)"
    }

    var managedByFormerMember: String {
        language == .korean ? "이전 멤버" : "A former member"
    }

    var managedByExplanation: String {
        language == .korean
            ? "이 에이전트는 아래 멤버가 관리합니다."
            : "This agent is managed by the member shown here."
    }

    var ownerLeftWorkspace: String {
        language == .korean ? "워크스페이스에서 나감" : "Left the workspace"
    }

    var ownerInactive: String {
        language == .korean ? "현재 비활성" : "Currently inactive"
    }

    var viewOwnerProfile: String {
        language == .korean ? "관리 주체 프로필 보기" : "View owner profile"
    }

    var agentRuntime: String {
        language == .korean ? "실행 위치" : "Runtime"
    }

    var agentExternalRuntime: String {
        language == .korean ? "외부 런타임" : "External runtime"
    }

    var agentExternalRuntimeAccessibility: String {
        language == .korean
            ? "실행 위치, 외부 런타임. 이 에이전트는 워크스페이스 밖에서 실행됩니다."
            : "Runtime, external. This agent runs outside the workspace."
    }
}
