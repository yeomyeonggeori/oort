import Foundation
import MomoCore
import SwiftUI

protocol MomoAgentSafetyBackend: Sendable {
    func agentPaused(_ agent: MemberID) async throws -> Bool
    func setAgentPaused(_ agent: MemberID, paused: Bool) async throws -> Bool
}

enum MomoAgentSafetyIssue: Sendable, Equatable {
    case unavailable
    case permissionDenied
    case notFound
    case conflict
    case connection
}

struct MomoAgentPauseRequestDTO: Codable {
    let paused: Bool
}

struct MomoAgentPauseProfileResponseDTO: Decodable {
    let profile: MomoAgentPauseProfileDTO
}

struct MomoAgentPauseProfileDTO: Decodable {
    let agentMemberId: String
    let workspaceId: String
    let paused: Bool
}

struct MomoAgentRunCancelResponseDTO: Decodable {
    let runId: String
    let status: String
    let linkedWorkSessionIds: [String]
    let workSessionsTerminated: Bool
}

struct MomoAgentPauseControl: View {
    @ObservedObject var viewModel: ChatViewModel
    let agent: Member
    let copy: MomoWorkspaceCopy

    var body: some View {
        GroupBox(copy.pauseAgent) {
            VStack(alignment: .leading, spacing: 8) {
                if let paused = viewModel.agentPauseStates[agent.id] {
                    Toggle(
                        copy.pauseAgent,
                        isOn: Binding(
                            get: { viewModel.agentPauseStates[agent.id] ?? paused },
                            set: { value in
                                Task { await viewModel.setAgentPaused(agent.id, paused: value) }
                            }
                        )
                    )
                    .disabled(viewModel.agentPauseMutationIDs.contains(agent.id))
                    .accessibilityValue(paused ? copy.agentPausedState : copy.agentActiveState)
                    .accessibilityIdentifier("agent-pause-toggle-\(agent.id.description.lowercased())")
                    if viewModel.agentPauseMutationIDs.contains(agent.id)
                        || viewModel.agentPauseLoadingIDs.contains(agent.id) {
                        ProgressView()
                            .controlSize(.small)
                            .accessibilityLabel(copy.agentPauseLoading)
                    }
                    if let issue = viewModel.agentPauseIssues[agent.id] {
                        pauseIssueContent(issue)
                    }
                } else if viewModel.agentPauseLoadingIDs.contains(agent.id) {
                    Label(copy.agentPauseLoading, systemImage: "clock")
                        .foregroundStyle(.secondary)
                } else {
                    pauseIssueContent(viewModel.agentPauseIssues[agent.id] ?? .unavailable)
                }

                Text(copy.agentPauseExplanation)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, 8)
        }
        .task(id: agent.id) {
            if viewModel.agentPauseStates[agent.id] == nil {
                await viewModel.refreshAgentPauseState(agent.id)
            }
        }
    }

    private func pauseIssueContent(_ issue: MomoAgentSafetyIssue) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(
                copy.agentPauseError(issue),
                systemImage: issue == .connection || issue == .unavailable
                    ? "wifi.slash"
                    : "exclamationmark.triangle"
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)

            Button(copy.retryAgentPause) {
                Task { await viewModel.refreshAgentPauseState(agent.id) }
            }
            .controlSize(.small)
            .disabled(viewModel.agentPauseLoadingIDs.contains(agent.id))
        }
    }
}
