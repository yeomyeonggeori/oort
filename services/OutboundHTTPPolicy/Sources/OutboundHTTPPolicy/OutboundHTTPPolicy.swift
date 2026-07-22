import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

public enum OutboundURLPolicyError: Error, Equatable, Sendable {
    case invalidURL
    case insecureHTTP
    case privateAddress
    case resolutionFailed
}

public protocol OutboundHostResolving: Sendable {
    func resolve(host: String) async throws -> [String]
}

/// DNS resolution shared by every server-owned fetch path. Field-by-field
/// initialization is load-bearing: Darwin and Glibc expose different addrinfo
/// memberwise initializer layouts.
public struct SystemOutboundHostResolver: OutboundHostResolving {
    public init() {}

    public func resolve(host: String) async throws -> [String] {
        try await Task.detached(priority: .utility) {
            var hints = addrinfo()
            hints.ai_flags = AI_ADDRCONFIG
            hints.ai_family = AF_UNSPEC
            #if os(Linux)
            hints.ai_socktype = Int32(SOCK_STREAM.rawValue)
            #else
            hints.ai_socktype = SOCK_STREAM
            #endif
            hints.ai_protocol = Int32(IPPROTO_TCP)
            var result: UnsafeMutablePointer<addrinfo>?
            guard getaddrinfo(host, nil, &hints, &result) == 0, let first = result else {
                throw OutboundURLPolicyError.resolutionFailed
            }
            defer { freeaddrinfo(first) }

            var addresses: Set<String> = []
            var cursor: UnsafeMutablePointer<addrinfo>? = first
            while let current = cursor {
                var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                if getnameinfo(
                    current.pointee.ai_addr,
                    current.pointee.ai_addrlen,
                    &buffer,
                    socklen_t(buffer.count),
                    nil,
                    0,
                    NI_NUMERICHOST
                ) == 0 {
                    let end = buffer.firstIndex(of: 0) ?? buffer.endIndex
                    addresses.insert(
                        String(decoding: buffer[..<end].map(UInt8.init), as: UTF8.self)
                    )
                }
                cursor = current.pointee.ai_next
            }
            guard !addresses.isEmpty else { throw OutboundURLPolicyError.resolutionFailed }
            return addresses.sorted()
        }.value
    }
}

public enum OutboundURLPolicy {
    /// Accept only absolute HTTP(S) URLs without embedded credentials or fragments.
    public static func validatedURL(
        _ url: URL,
        allowDevelopmentHTTP: Bool
    ) throws -> URL {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.fragment == nil
        else { throw OutboundURLPolicyError.invalidURL }
        if scheme == "http" {
            guard allowDevelopmentHTTP else { throw OutboundURLPolicyError.insecureHTTP }
        } else if scheme != "https" {
            throw OutboundURLPolicyError.invalidURL
        }
        if isDeniedAddress(host) { throw OutboundURLPolicyError.privateAddress }
        return url
    }

    /// Require every DNS answer to be public, then return the sorted answers so
    /// callers can pin their connection to one of the addresses that was checked.
    public static func validatedResolvedAddresses<Resolver: OutboundHostResolving>(
        for url: URL,
        resolver: Resolver
    ) async throws -> [String] {
        guard let host = url.host?.lowercased(), !host.isEmpty else {
            throw OutboundURLPolicyError.invalidURL
        }
        if isDeniedAddress(host) { throw OutboundURLPolicyError.privateAddress }
        let addresses: [String]
        do { addresses = try await resolver.resolve(host: host) }
        catch { throw OutboundURLPolicyError.resolutionFailed }
        guard !addresses.isEmpty, addresses.allSatisfy({ !isDeniedAddress($0) }) else {
            throw OutboundURLPolicyError.privateAddress
        }
        return addresses.sorted()
    }

    public static func isDeniedAddress(_ raw: String) -> Bool {
        let host = raw.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host.hasSuffix(".localhost") { return true }

        var ipv4 = in_addr()
        if host.withCString({ inet_pton(AF_INET, $0, &ipv4) }) == 1 {
            let value = UInt32(bigEndian: ipv4.s_addr)
            let a = UInt8((value >> 24) & 0xff)
            let b = UInt8((value >> 16) & 0xff)
            let c = UInt8((value >> 8) & 0xff)
            return a == 0 || a == 10 || a == 127 || a >= 224
                || (a == 100 && (64...127).contains(b))
                || (a == 169 && b == 254)
                || (a == 172 && (16...31).contains(b))
                || (a == 192 && b == 168)
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 0 && c == 2)
                || (a == 198 && (b == 18 || b == 19 || b == 51))
                || (a == 203 && b == 0 && c == 113)
        }

        var ipv6 = in6_addr()
        if host.withCString({ inet_pton(AF_INET6, $0, &ipv6) }) == 1 {
            let bytes = withUnsafeBytes(of: &ipv6) { Array($0) }
            if bytes.allSatisfy({ $0 == 0 }) { return true }
            if bytes.dropLast().allSatisfy({ $0 == 0 }) && bytes.last == 1 { return true }
            if bytes[0] == 0xff || (bytes[0] & 0xfe) == 0xfc { return true }
            if bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80 { return true }
            if bytes[0...3].elementsEqual([0x20, 0x01, 0x0d, 0xb8]) { return true }
            if bytes[0..<10].allSatisfy({ $0 == 0 })
                && bytes[10] == 0xff && bytes[11] == 0xff {
                return isDeniedAddress(
                    "\(bytes[12]).\(bytes[13]).\(bytes[14]).\(bytes[15])"
                )
            }
            return false
        }
        return false
    }
}
