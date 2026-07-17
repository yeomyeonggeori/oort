import Hummingbird

@main
struct LinkShortMain {
    static func main() async throws {
        let config = try Config.load()
        let app = AppBuilder.build(config: config)
        try await app.runService()
    }
}
