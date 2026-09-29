// CryptoKit half of the #3021 shared vectors (ADR-0146 개정 2026-09-28 D-5;
// momo.human.control.v2 #3027; v3 #3118).
// Invoked by generate.mjs: `swift cryptokit.swift <vectors.json>`.
//
// Builds every case's content bytes and signed payload **independently** in
// Swift (UUIDs parsed and re-rendered with `uuidString.lowercased()`, NFC via
// `precomposedStringWithCanonicalMapping`, canonical JSON below), then signs:
//   * `cryptokit`                — P256.Signing software key, scalar =
//                                  SHA-256("momo.human.signing.vectors/cryptokit")
//   * `cryptokit-secure-enclave` — an ephemeral SecureEnclave.P256 key (same byte
//                                  format as the phone/desktop keys; not
//                                  persisted). A Mac without a Secure Enclave
//                                  exits 2 instead of writing partial vectors.
// Prints JSON: {"cases":[{"name","payload_b64","signatures":[...]}]}.

import CryptoKit
import Foundation

enum VectorError: Error { case bad(String) }

func uuid(_ any: Any?) throws -> String {
    guard let s = any as? String, let u = UUID(uuidString: s) else { throw VectorError.bad("uuid \(String(describing: any))") }
    return u.uuidString.lowercased()
}

func int64(_ any: Any?) throws -> Int64 {
    guard let n = any as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), !CFNumberIsFloatType(n) else {
        throw VectorError.bad("int \(String(describing: any))")
    }
    return n.int64Value
}

func str(_ any: Any?) throws -> String {
    guard let s = any as? String else { throw VectorError.bad("string \(String(describing: any))") }
    return s
}

func nfc(_ s: String) -> String { s.precomposedStringWithCanonicalMapping }

func sha256Hex(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }

// Canonical JSON — must equal momo_wire::human_control::canonical_json.
func jsonString(_ s: String) -> String {
    var out = "\""
    for scalar in s.unicodeScalars {
        switch scalar {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\u{08}": out += "\\b"
        case "\u{0C}": out += "\\f"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if scalar.value < 0x20 {
                out += String(format: "\\u%04x", scalar.value)
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
    }
    return out + "\""
}

func canonicalJson(_ v: Any) throws -> String {
    if v is NSNull { return "null" }
    if let n = v as? NSNumber {
        if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? "true" : "false" }
        guard !CFNumberIsFloatType(n) else { throw VectorError.bad("float in manifest") }
        let i = n.int64Value
        guard abs(i) <= 9_007_199_254_740_991 else { throw VectorError.bad("unsafe integer") }
        return String(i)
    }
    if let s = v as? String { return jsonString(s) }
    if let a = v as? [Any] { return "[" + (try a.map(canonicalJson)).joined(separator: ",") + "]" }
    if let o = v as? [String: Any] {
        let keys = o.keys.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
        return "{" + (try keys.map { jsonString($0) + ":" + (try canonicalJson(o[$0]!)) }).joined(separator: ",") + "}"
    }
    throw VectorError.bad("json value \(v)")
}

func contentBytes(_ c: [String: Any], schema: String) throws -> Data {
    let text: String
    switch try str(c["kind"]) {
    case "input":
        text = nfc(try str(c["text"]))
    case "spawn" where schema == "momo.human.control.v2" || schema == "momo.human.control.v3":
        // v2 (#3027): the tool and the channel, before the free-text prompt.
        text = "\(try uuid(c["agent_member_id"]))\n\(try str(c["folder_id"]))\n\(try str(c["tool"]))\n\(try uuid(c["channel_id"]))\n\(nfc(try str(c["first_prompt"])))"
    case "spawn":
        text = "\(try uuid(c["agent_member_id"]))\n\(try str(c["folder_id"]))\n\(nfc(try str(c["first_prompt"])))"
    case "permission":
        let base = "\(try uuid(c["request_event_id"]))\n\(try str(c["option_id"]))\n\(try str(c["option_kind"]))\n\(try str(c["scope"]))"
        if schema == "momo.human.control.v3" {
            // v3 (#3118): the preview's hash, as the host computed it.
            let hash = try str(c["preview_sha256"])
            guard hash.count == 64, hash.allSatisfy({ "0123456789abcdef".contains($0) }) else {
                throw VectorError.bad("preview_sha256")
            }
            text = "\(base)\n\(hash)"
        } else {
            guard c["preview_sha256"] == nil else { throw VectorError.bad("only v3 binds a preview") }
            text = base
        }
    case "bundle_manifest":
        text = try canonicalJson(c["manifest"]!)
    case "host_register":
        text = "\(try str(c["host_public_key_b64"]))\n\(try uuid(c["host_id"]))\n\(nfc(try str(c["label"])))"
    case let k:
        throw VectorError.bad("kind \(k)")
    }
    return Data(text.utf8)
}

func payload(_ tc: [String: Any]) throws -> Data {
    let schema = try str(tc["schema"])
    let f = tc["fields"] as! [String: Any]
    var lines = [schema]
    switch schema {
    case "momo.human.control.v1", "momo.human.control.v2", "momo.human.control.v3":
        let c = tc["content"] as! [String: Any]
        let kind = try str(c["kind"])
        let session = f["session_id"] is NSNull ? "-" : try uuid(f["session_id"])
        lines += [
            try str(f["instance_id"]), try uuid(f["workspace_id"]), try uuid(f["member_id"]),
            try uuid(f["device_key_id"]), try uuid(f["host_id"]), session, kind,
            kind == "input" ? try str(c["mode"]) : "-",
            try uuid(f["nonce"]), String(try int64(f["issued_at_ms"])), String(try int64(f["expires_at_ms"])),
            sha256Hex(try contentBytes(c, schema: schema)),
        ]
    case "momo.human.device_endorse.v1":
        lines += [
            try uuid(f["workspace_id"]), try uuid(f["member_id"]), try uuid(f["root_key_id"]),
            try str(f["target_alg"]), try str(f["target_public_key_b64"]), nfc(try str(f["label"])),
        ]
    case "momo.human.device_revoke.v1":
        lines += [
            try uuid(f["workspace_id"]), try uuid(f["member_id"]), try uuid(f["root_key_id"]),
            try uuid(f["target_key_id"]), String(try int64(f["revoked_at_ms"])),
        ]
    case "momo.human.device_revoke.v2":
        // #3068: v2 names the revoked public key.
        lines += [
            try uuid(f["workspace_id"]), try uuid(f["member_id"]), try uuid(f["root_key_id"]),
            try uuid(f["target_key_id"]), try str(f["target_public_key_b64"]),
            String(try int64(f["revoked_at_ms"])),
        ]
    default:
        throw VectorError.bad("schema \(schema)")
    }
    return Data(lines.joined(separator: "\n").utf8)
}

let path = CommandLine.arguments[1]
let doc = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [String: Any]
let seed = Data(SHA256.hash(data: Data("momo.human.signing.vectors/cryptokit".utf8)))
let software = try P256.Signing.PrivateKey(rawRepresentation: seed)
// The committed file must carry a Secure Enclave signature (the Rust test
// requires it), so a Mac without one refuses rather than writing a file the
// tests reject.
guard SecureEnclave.isAvailable else {
    FileHandle.standardError.write(Data("no Secure Enclave: run on an Apple silicon / T2 Mac\n".utf8))
    exit(2)
}
let enclave: SecureEnclave.P256.Signing.PrivateKey? = try SecureEnclave.P256.Signing.PrivateKey()

var out: [[String: Any]] = []
for tc in doc["cases"] as! [[String: Any]] {
    let bytes = try payload(tc)
    var sigs: [[String: String]] = [[
        "signer": "cryptokit",
        "public_key": software.publicKey.compressedRepresentation.base64EncodedString(),
        "signature": try software.signature(for: bytes).rawRepresentation.base64EncodedString(),
    ]]
    if let enclave {
        sigs.append([
            "signer": "cryptokit-secure-enclave",
            "public_key": enclave.publicKey.compressedRepresentation.base64EncodedString(),
            "signature": try enclave.signature(for: bytes).rawRepresentation.base64EncodedString(),
        ])
    }
    out.append(["name": try str(tc["name"]), "payload_b64": bytes.base64EncodedString(), "signatures": sigs])
}
FileHandle.standardError.write(Data("secure enclave: \(enclave != nil)\n".utf8))
print(String(data: try JSONSerialization.data(withJSONObject: ["cases": out]), encoding: .utf8)!)
