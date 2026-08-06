import Foundation

protocol IOSHTTPDataTransport: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

private struct IOSURLSessionDataTransport: IOSHTTPDataTransport {
    let session: URLSession

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        try await session.data(for: request)
    }
}

/// Owns the native session token pair for one signed-in identity.
///
/// The refresh token is single use. Actor isolation plus `refreshTask` funnels
/// concurrent 401 responses into one rotation, then each caller retries once.
/// Rotated credentials are committed to Keychain before becoming active.
public actor IOSAuthenticatedRequestExecutor {
    private struct RefreshRequest: Encodable, Sendable { let refreshToken: String }
    private struct RefreshResponse: Decodable, Sendable {
        let accessToken: String
        let refreshToken: String
    }
    private struct ProblemResponse: Decodable {
        let title: String?
        let detail: String?
        let message: String?
    }

    private var authenticated: IOSSession
    private let store: SessionStore
    private let transport: any IOSHTTPDataTransport
    private let downloadSession: URLSession
    private var refreshTask: Task<RefreshResponse, Error>?

    public init(
        authenticated: IOSSession,
        store: SessionStore = .shared,
        urlSession: URLSession = .shared
    ) {
        self.authenticated = Self.newestStoredSession(matching: authenticated, in: store)
        self.store = store
        self.transport = IOSURLSessionDataTransport(session: urlSession)
        self.downloadSession = urlSession
    }

    init(
        authenticated: IOSSession,
        store: SessionStore,
        transport: any IOSHTTPDataTransport,
        downloadSession: URLSession = .shared
    ) {
        self.authenticated = Self.newestStoredSession(matching: authenticated, in: store)
        self.store = store
        self.transport = transport
        self.downloadSession = downloadSession
    }

    public func currentSession() -> IOSSession { authenticated }

    public func data(for request: URLRequest) async throws -> Data {
        let presentedAccessToken = authenticated.accessToken
        let first = try await performData(authorized(request, with: presentedAccessToken))
        if first.response.statusCode != 401 {
            return try validatedData(first.data, response: first.response)
        }

        let refreshed = if authenticated.accessToken != presentedAccessToken {
            authenticated
        } else {
            try await refreshSession()
        }
        let retry = try await performData(authorized(request, with: refreshed.accessToken))
        guard retry.response.statusCode != 401 else { throw SessionError.sessionExpired }
        return try validatedData(retry.data, response: retry.response)
    }

    public func download(for request: URLRequest) async throws -> (URL, URLResponse) {
        let presentedAccessToken = authenticated.accessToken
        let first = try await downloadSession.download(
            for: authorized(request, with: presentedAccessToken)
        )
        if (first.1 as? HTTPURLResponse)?.statusCode != 401 { return first }
        let refreshed = if authenticated.accessToken != presentedAccessToken {
            authenticated
        } else {
            try await refreshSession()
        }
        let retry = try await downloadSession.download(
            for: authorized(request, with: refreshed.accessToken)
        )
        guard (retry.1 as? HTTPURLResponse)?.statusCode != 401 else {
            throw SessionError.sessionExpired
        }
        return retry
    }

    private func refreshSession() async throws -> IOSSession {
        let presentedRefreshToken = authenticated.refreshToken
        let task: Task<RefreshResponse, Error>
        if let refreshTask {
            task = refreshTask
        } else {
            let request = try makeRefreshRequest(refreshToken: presentedRefreshToken)
            let transport = transport
            task = Task {
                let (data, response) = try await transport.data(for: request)
                guard let http = response as? HTTPURLResponse else {
                    throw SessionError.transport("The server did not return an HTTP response.")
                }
                guard (200..<300).contains(http.statusCode) else {
                    throw SessionError.sessionExpired
                }
                do {
                    return try JSONDecoder().decode(RefreshResponse.self, from: data)
                } catch {
                    throw SessionError.decoding("The server returned an invalid session refresh response.")
                }
            }
            refreshTask = task
        }

        do {
            let pair = try await task.value
            if authenticated.refreshToken == presentedRefreshToken {
                var rotated = authenticated
                rotated.accessToken = pair.accessToken
                rotated.refreshToken = pair.refreshToken
                guard store.save(session: rotated) else { throw SessionError.secureStorage }
                authenticated = rotated
            }
            refreshTask = nil
            return authenticated
        } catch is CancellationError {
            refreshTask = nil
            throw CancellationError()
        } catch let error as SessionError {
            refreshTask = nil
            throw error
        } catch {
            refreshTask = nil
            throw SessionError.transport("The oort session could not be refreshed. Check your connection and try again.")
        }
    }

    private func makeRefreshRequest(refreshToken: String) throws -> URLRequest {
        var request = URLRequest(url: authenticated.baseURL.appendingPathComponent("/v1/auth/refresh"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(RefreshRequest(refreshToken: refreshToken))
        return request
    }

    private func authorized(_ request: URLRequest, with accessToken: String) -> URLRequest {
        var request = request
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        return request
    }

    private func performData(_ request: URLRequest) async throws -> (data: Data, response: HTTPURLResponse) {
        do {
            let (data, response) = try await transport.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw SessionError.transport("The server did not return an HTTP response.")
            }
            return (data, http)
        } catch let error as SessionError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw SessionError.transport("Could not reach the oort server. Check your connection and try again.")
        }
    }

    private func validatedData(_ data: Data, response: HTTPURLResponse) throws -> Data {
        guard (200..<300).contains(response.statusCode) else {
            let problem = try? JSONDecoder().decode(ProblemResponse.self, from: data)
            let plainBody = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let message = problem?.detail ?? problem?.message ?? problem?.title
                ?? (plainBody?.isEmpty == false ? plainBody : nil)
                ?? HTTPURLResponse.localizedString(forStatusCode: response.statusCode)
            throw SessionError.server(status: response.statusCode, message: message)
        }
        return data
    }

    private static func newestStoredSession(
        matching candidate: IOSSession,
        in store: SessionStore
    ) -> IOSSession {
        guard let stored = store.loadSession(),
              stored.baseURL == candidate.baseURL,
              stored.workspaceID == candidate.workspaceID,
              stored.member.id == candidate.member.id
        else { return candidate }
        return stored
    }
}
