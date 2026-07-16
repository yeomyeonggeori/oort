import Hummingbird
import Logging

/// Request logger that preserves the existing metadata contract while removing
/// Slack-compatible URL secrets before they reach any logging backend.
struct SecretRedactingRequestLogMiddleware<Context: RequestContext>: RouterMiddleware {
    let logLevel: Logger.Level

    init(_ logLevel: Logger.Level) {
        self.logLevel = logLevel
    }

    func handle(
        _ request: Request,
        context: Context,
        next: (Request, Context) async throws -> Response
    ) async throws -> Response {
        let rawPath = String(describing: request.uri)
        let loggedPath = Self.redactedPath(rawPath)
        context.logger.log(
            level: logLevel,
            "Request",
            metadata: [
                "hb.request.path": .string(loggedPath),
                "hb.request.method": .string(request.method.rawValue),
            ]
        )
        return try await next(request, context)
    }

    static func redactedPath(_ path: String) -> String {
        path.hasPrefix("/hooks/") ? "/hooks/[REDACTED]" : path
    }
}
