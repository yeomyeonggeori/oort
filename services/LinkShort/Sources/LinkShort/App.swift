import Hummingbird

enum AppBuilder {
    static func build(config: Config) -> some ApplicationProtocol {
        let redirector = Redirector(targetBaseURL: config.targetBaseURL)
        let router = Router(context: BasicRequestContext.self)

        router.get("/healthz") { _, _ -> HTTPResponse.Status in
            .ok
        }
        router.get("/i/:code") { _, context -> Response in
            guard let code = context.parameters.get("code"),
                let location = try? redirector.location(for: code)
            else {
                return Response(status: .badRequest)
            }

            var headers = HTTPFields()
            headers[.location] = location
            return Response(status: .found, headers: headers)
        }

        return Application(
            router: router,
            configuration: .init(
                address: .hostname("127.0.0.1", port: config.port),
                serverName: "LinkShort"
            )
        )
    }
}
