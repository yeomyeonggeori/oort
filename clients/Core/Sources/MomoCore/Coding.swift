import Foundation

// MARK: - Shared JSON coders
//
// Models declare their own snake_case CodingKeys explicitly (so they round-trip
// against Postgres column names without relying on a global key strategy). These
// shared coders just standardize a few cross-cutting policies and give callers a
// single, consistent encoder/decoder to use across the app + the envelope mapper.

extension JSONDecoder {
    /// The canonical decoder for momo wire JSON.
    public static var momo: JSONDecoder {
        let d = JSONDecoder()
        // Timestamps are transported as integer `_ms` fields (L4 §5.1), already
        // modeled as Int64, so no date strategy is needed.
        return d
    }
}

extension JSONEncoder {
    /// The canonical encoder for momo wire JSON.
    public static var momo: JSONEncoder {
        let e = JSONEncoder()
        return e
    }
}
