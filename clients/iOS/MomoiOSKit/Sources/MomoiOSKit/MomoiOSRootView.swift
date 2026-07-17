import Foundation
import MomoCore
import Observation
#if os(iOS)
import SwiftUI
#endif

@MainActor
@Observable
public final class MomoiOSAppModel {
    public enum FailureKind: Equatable {
        case offline
        case other
    }

    public enum Phase: Equatable {
        case signedOut
        case connecting
        case signedIn(IOSSession, WorkspaceBootstrap)
    }

    public var form: SessionForm
    public private(set) var phase: Phase
    public private(set) var errorMessage: String?
    public private(set) var failureKind: FailureKind?

    private let store: SessionStore
    private let backend: any SessionBackend
    private let pushLifecycle: any IOSPushLifecycle

    public init(
        store: SessionStore = .shared,
        backend: any SessionBackend = MomoServerSessionClient(),
        pushLifecycle: any IOSPushLifecycle = NoopIOSPushLifecycle.shared
    ) {
        self.store = store
        self.backend = backend
        self.pushLifecycle = pushLifecycle
        self.form = store.loadForm()
        self.phase = .signedOut
        self.failureKind = nil
    }

    public func restore() async {
        guard case .signedOut = phase, let session = store.loadSession() else { return }
        await bootstrap(session: session, saveForm: false)
    }

    public func authenticate() async {
        guard case .signedOut = phase else { return }
        errorMessage = nil
        failureKind = nil
        phase = .connecting
        do {
            _ = try form.validated()
            let session = try await backend.authenticate(form: form)
            let bootstrap = try await backend.bootstrap(session: session)
            store.save(form: form)
            store.save(session: session)
            phase = .signedIn(session, bootstrap)
            await pushLifecycle.activate(session: session)
        } catch is CancellationError {
            phase = .signedOut
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            failureKind = Self.failureKind(for: error)
            phase = .signedOut
        }
    }

    public func signOut() async {
        if case .signedIn(let session, _) = phase {
            await pushLifecycle.revoke(session: session)
        }
        store.clearSession()
        errorMessage = nil
        failureKind = nil
        phase = .signedOut
    }

    private func bootstrap(session: IOSSession, saveForm: Bool) async {
        errorMessage = nil
        failureKind = nil
        phase = .connecting
        do {
            let bootstrap = try await backend.bootstrap(session: session)
            if saveForm { store.save(form: form) }
            phase = .signedIn(session, bootstrap)
            await pushLifecycle.activate(session: session)
        } catch is CancellationError {
            phase = .signedOut
        } catch {
            store.clearSession()
            failureKind = Self.failureKind(for: error)
            errorMessage = failureKind == .offline
                ? "Could not reach the momo server. Check the URL and try again."
                : "Your saved session could not be restored. Sign in again."
            phase = .signedOut
        }
    }

    private static func failureKind(for error: Error) -> FailureKind {
        guard let sessionError = error as? SessionError else { return .other }
        if case .transport = sessionError { return .offline }
        return .other
    }
}

#if os(iOS)
@MainActor
public struct MomoiOSRootView: View {
    @State private var model: MomoiOSAppModel
    @State private var navigationPath: [IOSPushDeepLink] = []
    @State private var deepLinkRouter: IOSPushDeepLinkRouter

    public init(
        model: MomoiOSAppModel = MomoiOSAppModel(),
        deepLinkRouter: IOSPushDeepLinkRouter = .shared
    ) {
        _model = State(initialValue: model)
        _deepLinkRouter = State(initialValue: deepLinkRouter)
    }

    public var body: some View {
        NavigationStack(path: $navigationPath) {
            switch model.phase {
            case .signedOut:
                LoginView(model: model)
            case .connecting:
                ProgressView("Connecting to momo")
                    .navigationTitle("momo")
            case .signedIn(let session, let bootstrap):
                IOSWorkspaceView(
                    session: session,
                    bootstrap: bootstrap,
                    signOut: model.signOut
                )
            }
        }
        .task { await model.restore() }
        .onOpenURL { deepLinkRouter.route(url: $0) }
        .task(id: deepLinkRouteTrigger) {
            guard let link = deepLinkRouter.consumePending(
                for: deepLinkRouteTrigger.signedInWorkspaceID
            ) else { return }
            navigationPath = [link]
        }
    }

    private var deepLinkRouteTrigger: DeepLinkRouteTrigger {
        let signedInWorkspaceID: WorkspaceID?
        if case .signedIn(let session, _) = model.phase {
            signedInWorkspaceID = session.workspaceID
        } else {
            signedInWorkspaceID = nil
        }
        return DeepLinkRouteTrigger(
            pending: deepLinkRouter.pending,
            signedInWorkspaceID: signedInWorkspaceID
        )
    }
}

private struct DeepLinkRouteTrigger: Equatable {
    let pending: IOSPushDeepLink?
    let signedInWorkspaceID: WorkspaceID?
}

@MainActor
private struct LoginView: View {
    @Bindable var model: MomoiOSAppModel

    var body: some View {
        Form {
            Section("Server") {
                TextField("Server URL", text: $model.form.serverURL)
                    .textContentType(.URL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("serverURL")
            }

            Section("Account") {
                TextField("Email", text: $model.form.email)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("email")
                SecureField("Password", text: $model.form.password)
                    .textContentType(.password)
                    .accessibilityIdentifier("password")
                TextField("Invite code (optional)", text: $model.form.inviteCode)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("inviteCode")
            }

            if let errorMessage = model.errorMessage {
                Section(model.failureKind == .offline ? "Connection unavailable" : "Sign-in issue") {
                    Label(
                        errorMessage,
                        systemImage: model.failureKind == .offline ? "wifi.slash" : "exclamationmark.triangle"
                    )
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("loginError")
                }
            }

            Section {
                Button(model.form.submitsInvite ? "Join workspace" : "Sign in") {
                    Task { await model.authenticate() }
                }
                .accessibilityIdentifier("authenticate")
            } footer: {
                Text("Development credentials are stored on this device in UserDefaults.")
            }
        }
        .navigationTitle("Sign in to momo")
    }
}

#endif
