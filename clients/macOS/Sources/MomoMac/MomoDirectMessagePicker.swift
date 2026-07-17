import SwiftUI
import MomoCore

struct MomoDirectMessagePicker: View {
    @ObservedObject var viewModel: ChatViewModel
    let copy: MomoWorkspaceCopy
    let dismiss: () -> Void
    @State private var query = ""
    @State private var errorMessage: String?
    @State private var selectedMemberID: MemberID?
    @FocusState private var isSearchFocused: Bool

    private var candidates: [Member] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
        return viewModel.members
            .filter { member in
                member.status == .active
                    && !viewModel.isCurrentUser(member.id)
                    && (needle.isEmpty
                        || member.displayName.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current).contains(needle)
                        || member.handle.lowercased().contains(needle.lowercased()))
            }
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(MomoTheme.Typography.screenTitle)
                    Text(subtitle).font(MomoTheme.Typography.supporting).foregroundStyle(.secondary)
                }
                Spacer()
                Button(copy.closeDetailPane, action: dismiss)
                    .keyboardShortcut(.cancelAction)
            }
            .padding(16)
            Divider()
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField(searchPlaceholder, text: $query)
                    .textFieldStyle(.plain)
                    .focused($isSearchFocused)
                    .onSubmit(openSelectedDirectMessage)
                    .onKeyPress(.upArrow) {
                        moveSelection(offset: -1)
                        return .handled
                    }
                    .onKeyPress(.downArrow) {
                        moveSelection(offset: 1)
                        return .handled
                    }
                    .onKeyPress(.escape) {
                        dismiss()
                        return .handled
                    }
            }
            .padding(8)
            .background(.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: MomoTheme.cornerSmall, style: .continuous))
            .padding(16)

            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle")
                    .font(MomoTheme.Typography.supporting)
                    .foregroundStyle(MomoTheme.irreversibleRed)
                    .padding(.horizontal, 16)
            }

            if candidates.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Label(emptyTitle, systemImage: query.isEmpty ? "person.2" : "magnifyingglass")
                        .font(MomoTheme.Typography.emphasizedRow)
                    Text(emptyDescription)
                        .font(MomoTheme.Typography.supporting)
                        .foregroundStyle(.secondary)
                    Button(closeAction, action: dismiss)
                        .buttonStyle(.bordered)
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                ScrollViewReader { proxy in
                    List(candidates) { member in
                        Button {
                            openDirectMessage(member)
                        } label: {
                            HStack(spacing: 12) {
                                memberAvatar(member)
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack(spacing: 6) {
                                        Text(member.displayName).font(MomoTheme.Typography.row)
                                        if member.isAgent {
                                            Text("AGENT").font(MomoTheme.Sidebar.badgeFont).foregroundStyle(MomoTheme.agentAccent)
                                        }
                                    }
                                    Text("@\(member.handle)").font(MomoTheme.Typography.metadata).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if viewModel.directMessageMutationIds.contains(member.id) {
                                    ProgressView().controlSize(.small)
                                } else {
                                    Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                                }
                            }
                            .contentShape(Rectangle())
                            .background(
                                selectedMemberID == member.id ? Color.primary.opacity(0.08) : Color.clear,
                                in: RoundedRectangle(cornerRadius: MomoTheme.cornerSmall, style: .continuous)
                            )
                        }
                        .buttonStyle(.plain)
                        .disabled(viewModel.directMessageMutationIds.contains(member.id))
                        .id(member.id)
                        .accessibilityValue(selectedMemberID == member.id ? selectedLabel : "")
                        .onHover { hovering in
                            if hovering { selectedMemberID = member.id }
                        }
                    }
                    .listStyle(.plain)
                    .onChange(of: selectedMemberID) { _, memberID in
                        guard let memberID else { return }
                        proxy.scrollTo(memberID, anchor: .center)
                    }
                }
            }
        }
        .frame(
            minWidth: MomoTheme.MemberDirectory.minimumWidth,
            minHeight: MomoTheme.MemberDirectory.minimumHeight
        )
        .onAppear {
            isSearchFocused = true
            selectedMemberID = candidates.first?.id
        }
        .onChange(of: query) { _, _ in
            selectedMemberID = candidates.first?.id
        }
        .onMoveCommand { direction in
            switch direction {
            case .up: moveSelection(offset: -1)
            case .down: moveSelection(offset: 1)
            default: break
            }
        }
    }

    @ViewBuilder
    private func memberAvatar(_ member: Member) -> some View {
        if let avatarURL = member.avatarURL {
            AsyncImage(url: avatarURL) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFill()
                } else {
                    fallbackAvatar(member)
                }
            }
            .frame(width: 32, height: 32)
            .clipShape(Circle())
        } else {
            fallbackAvatar(member)
        }
    }

    private func fallbackAvatar(_ member: Member) -> some View {
        ZStack {
            Circle().fill(
                member.isAgent
                    ? MomoTheme.agentAccent.opacity(0.2)
                    : MomoTheme.humanAccent.opacity(0.2)
            )
            Text(String(member.displayName.prefix(1)).uppercased())
                .font(.callout.weight(.semibold))
                .foregroundStyle(member.isAgent ? MomoTheme.agentAccent : MomoTheme.humanAccent)
        }
        .frame(width: 32, height: 32)
    }

    private func openDirectMessage(_ member: Member) {
        errorMessage = nil
        Task {
            let outcome = await viewModel.startDirectMessage(with: member.id)
            switch outcome {
            case .opened:
                dismiss()
            case .failed:
                errorMessage = failureMessage
            case .ignored:
                break
            }
        }
    }

    private func moveSelection(offset: Int) {
        guard !candidates.isEmpty else { selectedMemberID = nil; return }
        let currentIndex = candidates.firstIndex { $0.id == selectedMemberID } ?? 0
        selectedMemberID = candidates[(currentIndex + offset + candidates.count) % candidates.count].id
    }

    private func openSelectedDirectMessage() {
        guard let member = candidates.first(where: { $0.id == selectedMemberID }) ?? candidates.first,
              !viewModel.directMessageMutationIds.contains(member.id)
        else { return }
        openDirectMessage(member)
    }

    private var isKorean: Bool { copy.language == .korean }
    private var title: String { isKorean ? "새 다이렉트 메시지" : "New direct message" }
    private var subtitle: String { isKorean ? "사람 또는 에이전트를 선택해 대화를 시작하세요." : "Choose a person or agent to start a conversation." }
    private var searchPlaceholder: String { isKorean ? "이름 또는 핸들 검색" : "Search name or handle" }
    private var emptyTitle: String {
        if query.isEmpty { return isKorean ? "대화할 멤버가 없습니다" : "No members available" }
        return isKorean ? "검색 결과가 없습니다" : "No results"
    }
    private var emptyDescription: String {
        if query.isEmpty {
            return isKorean ? "워크스페이스 메뉴에서 사람이나 에이전트를 먼저 초대하세요." : "Invite a person or agent from the workspace menu first."
        }
        return isKorean ? "다른 이름이나 핸들로 검색해보세요." : "Try another name or handle."
    }
    private var failureMessage: String { isKorean ? "대화를 열지 못했습니다. 연결 상태를 확인하고 다시 시도하세요." : "Could not open the conversation. Check your connection and try again." }
    private var closeAction: String { isKorean ? "닫기" : "Close" }
    private var selectedLabel: String { isKorean ? "선택됨" : "Selected" }
}
