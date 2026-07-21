enum RedirectError: Error, Equatable {
    case invalidCode
}

struct Redirector: Sendable {
    let targetBaseURL: String

    func location(for code: String) throws -> String {
        guard Self.isURLSafe(code) else {
            throw RedirectError.invalidCode
        }
        return "\(targetBaseURL)/join?code=\(code)"
    }

    static func isURLSafe(_ code: String) -> Bool {
        !code.isEmpty && code.unicodeScalars.allSatisfy { scalar in
            switch scalar.value {
            case 45, 46, 48...57, 65...90, 95, 97...122, 126:
                true
            default:
                false
            }
        }
    }
}
