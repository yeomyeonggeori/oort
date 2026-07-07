import Foundation

/// Constant-time string equality for secret comparison (MOMO-300).
///
/// Shared by the Centrifugo subscribe-proxy secret check and the platform
/// admin login secret check — any secret-vs-secret comparison must go through
/// here instead of `==`, which short-circuits on the first differing byte and
/// leaks match-prefix length via timing.
///
/// Length is compared first — leaking the secret's length is acceptable for
/// these high-entropy secrets.
enum ConstantTime {
    static func equals(_ lhs: String, _ rhs: String) -> Bool {
        let a = Array(lhs.utf8)
        let b = Array(rhs.utf8)
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count {
            diff |= a[i] ^ b[i]
        }
        return diff == 0
    }
}
