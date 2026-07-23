import Foundation

/// Placement policy for the empty-channel onboarding surface (MOMO-570).
///
/// Agent creation is offered at equal footing with people invitation. When the
/// viewer can do neither (a non-admin), the surface stays visible and points at the
/// request path instead of hiding, so the invitation to act is never silently
/// removed.
enum MomoEmptyChannelOnboardingPolicy {
    struct Actions: Equatable {
        let canInvitePeople: Bool
        let canCreateAgent: Bool

        var showsManagementActions: Bool { canInvitePeople || canCreateAgent }
        var showsRequestGuidance: Bool { !showsManagementActions }
    }

    /// - Parameters:
    ///   - canManageChannelMembers: viewer may add members to this channel.
    ///   - invitePeopleAvailable: an invite hook is wired (a nil hook means the
    ///     capability is absent, e.g. a non-admin viewer).
    ///   - createAgentAvailable: an agent-creation hook is wired. The host gates it
    ///     on workspace management plus backend support before wiring the hook, so
    ///     this flag already carries the permission decision.
    static func actions(
        canManageChannelMembers: Bool,
        invitePeopleAvailable: Bool,
        createAgentAvailable: Bool
    ) -> Actions {
        Actions(
            canInvitePeople: canManageChannelMembers && invitePeopleAvailable,
            canCreateAgent: createAgentAvailable
        )
    }
}

/// The click budget from an empty channel to a first agent mention.
///
/// MOMO-570 exit condition: at most four clicks. The auto-invite step runs on
/// creation completion (the host adds the new agent to the current channel), so it
/// costs no click.
enum MomoEmptyChannelAgentJourney {
    enum Step: Equatable {
        /// Tap the empty-channel "Add agent" entry point.
        case openCreateAgent
        /// Confirm the agent address to review its published capabilities.
        case reviewAgent
        /// Add the reviewed agent to the workspace; creation completes here.
        case addToWorkspace
        /// Host adds the new agent to the current channel automatically.
        case autoInviteToChannel
        /// Mention the agent in the composer for the first time.
        case mentionAgent

        var requiresClick: Bool { self != .autoInviteToChannel }
    }

    static let steps: [Step] = [
        .openCreateAgent,
        .reviewAgent,
        .addToWorkspace,
        .autoInviteToChannel,
        .mentionAgent,
    ]

    /// Number of user clicks the journey requires (auto-invite excluded).
    static var clickCount: Int { steps.filter(\.requiresClick).count }
}
