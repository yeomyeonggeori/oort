import Foundation
import Network

// MARK: - LAN server discovery (MOMO-587, onboarding "와우" W-O2 client side)
//
// The internal-alpha stack (586) advertises the MomoServer over Bonjour as
// `_momo._tcp` with a TXT record whose `base` key holds the API base URL
// (for example `http://MacBook-Pro-2.local:28000`). This file browses for that
// service so the chooser can *quietly* offer the address instead of making a new
// teammate type it by hand.
//
// The discovery logic is split into three layers so the decision-making stays
// pure and unit-testable without a live network:
//   1. `MomoServerDiscovery` — pure functions that turn raw browse results into
//      the servers the UI should offer (validation, dedupe, display naming).
//   2. `MomoServerBrowsing` — the mockable seam the model depends on.
//   3. `MomoServerDiscoveryModel` — the observable lifecycle (start/timeout/stop)
//      that the chooser binds to. Not found / denied / timed out all resolve to
//      an empty `servers`, which the chooser renders as complete silence.

/// A raw sighting reported by a browser, before validation.
public struct MomoServerDiscoveryResult: Equatable, Sendable {
    /// The Bonjour instance name (used only as a display fallback).
    public var serviceName: String
    /// The advertised API base URL from the TXT record `base` key, if present.
    public var baseURLString: String?

    public init(serviceName: String, baseURLString: String?) {
        self.serviceName = serviceName
        self.baseURLString = baseURLString
    }
}

/// A validated server the chooser is willing to offer.
public struct MomoDiscoveredServer: Identifiable, Equatable, Sendable {
    /// The validated API base URL to prefill into the session form.
    public var baseURLString: String
    /// A short, human-readable host label, for example `MacBook-Pro-2.local:28000`.
    public var displayHost: String

    public var id: String { baseURLString }

    public init(baseURLString: String, displayHost: String) {
        self.baseURLString = baseURLString
        self.displayHost = displayHost
    }
}

/// Lifecycle events a browser reports to the model.
public enum MomoServerDiscoveryEvent: Sendable {
    /// The current full set of results the browser can see.
    case results([MomoServerDiscoveryResult])
    /// The browser could not run (permission denied, interface error). The model
    /// treats this as silence rather than surfacing an error to the user.
    case failed
}

/// The seam the model browses through. The production implementation wraps
/// `NWBrowser`; tests inject a mock that emits events synchronously.
///
/// Implementations MUST deliver `onEvent` on the main actor.
public protocol MomoServerBrowsing: AnyObject {
    func start(onEvent: @escaping @Sendable @MainActor (MomoServerDiscoveryEvent) -> Void)
    func cancel()
}

// MARK: - Pure decision layer

public enum MomoServerDiscovery {
    /// Bonjour service type advertised by the internal-alpha stack (586).
    public static let serviceType = "_momo._tcp"
    /// TXT record key holding the API base URL.
    public static let txtBaseKey = "base"

    /// Turn raw browse results into the servers the chooser should offer.
    ///
    /// Pure: keeps only results whose TXT `base` is a well-formed http(s) URL with
    /// a host, dedupes by that URL, and preserves discovery order. An empty return
    /// is the signal for the chooser to stay silent.
    public static func servers(from results: [MomoServerDiscoveryResult]) -> [MomoDiscoveredServer] {
        var seen = Set<String>()
        var offered: [MomoDiscoveredServer] = []
        for result in results {
            guard let raw = result.baseURLString?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !raw.isEmpty,
                  let url = URL(string: raw),
                  let scheme = url.scheme?.lowercased(),
                  scheme == "http" || scheme == "https",
                  let host = url.host,
                  !host.isEmpty,
                  seen.insert(raw).inserted
            else { continue }
            offered.append(
                MomoDiscoveredServer(baseURLString: raw, displayHost: displayHost(url: url, fallback: result.serviceName))
            )
        }
        return offered
    }

    /// A short host label for the suggestion, keeping a non-default port because
    /// the alpha stack listens on `:28000`/`:28180`.
    static func displayHost(url: URL, fallback: String) -> String {
        guard let host = url.host, !host.isEmpty else {
            return fallback.isEmpty ? url.absoluteString : fallback
        }
        if let port = url.port {
            return "\(host):\(port)"
        }
        return host
    }
}

// MARK: - Observable lifecycle

@MainActor
public final class MomoServerDiscoveryModel: ObservableObject {
    /// Servers the chooser should offer. Empty means stay silent.
    @Published public private(set) var servers: [MomoDiscoveredServer]

    private let browseTimeout: Duration
    private let makeBrowser: () -> MomoServerBrowsing
    private var browser: MomoServerBrowsing?
    private var timeoutTask: Task<Void, Never>?
    private var started = false

    /// - Parameters:
    ///   - seeded: pre-populated servers for previews and snapshot fixtures.
    ///   - browseTimeout: how long to keep scanning before stopping. Whatever was
    ///     found by then remains offered; if nothing was found the chooser is silent.
    ///   - makeBrowser: factory for the browsing seam (mocked in tests).
    public init(
        seeded: [MomoDiscoveredServer] = [],
        browseTimeout: Duration = .seconds(4),
        makeBrowser: @escaping () -> MomoServerBrowsing = { MomoBonjourServerBrowser() }
    ) {
        self.servers = seeded
        self.browseTimeout = browseTimeout
        self.makeBrowser = makeBrowser
    }

    /// Begin browsing. Idempotent; safe to call from `.onAppear`.
    public func start() {
        guard !started else { return }
        started = true
        let browser = makeBrowser()
        self.browser = browser
        browser.start { [weak self] event in
            self?.apply(event)
        }
        timeoutTask = Task { @MainActor [weak self, browseTimeout] in
            try? await Task.sleep(for: browseTimeout)
            guard !Task.isCancelled else { return }
            self?.stopBrowsing()
        }
    }

    /// Apply a browser event. Exposed for deterministic unit tests.
    func apply(_ event: MomoServerDiscoveryEvent) {
        switch event {
        case .results(let results):
            servers = MomoServerDiscovery.servers(from: results)
        case .failed:
            // Permission denied / interface error: stay silent, stop scanning.
            // Anything already found stays offered (denial happens before results).
            stopBrowsing()
        }
    }

    /// Stop browsing and release the network resource. Idempotent.
    public func stop() {
        stopBrowsing()
    }

    private func stopBrowsing() {
        timeoutTask?.cancel()
        timeoutTask = nil
        browser?.cancel()
        browser = nil
    }

    deinit {
        // The browser is released with the model; the chooser also calls stop()
        // on disappear. Only the Sendable timer task is safe to touch here.
        timeoutTask?.cancel()
    }
}

// MARK: - NWBrowser implementation

/// Browses `_momo._tcp` via `NWBrowser`, reading the API base URL straight from
/// the TXT record so no host/port resolution round-trip is needed.
public final class MomoBonjourServerBrowser: MomoServerBrowsing {
    private var browser: NWBrowser?

    public init() {}

    public func start(onEvent: @escaping @Sendable @MainActor (MomoServerDiscoveryEvent) -> Void) {
        let parameters = NWParameters()
        parameters.includePeerToPeer = false
        let descriptor = NWBrowser.Descriptor.bonjourWithTXTRecord(
            type: MomoServerDiscovery.serviceType,
            domain: nil
        )
        let browser = NWBrowser(for: descriptor, using: parameters)
        self.browser = browser

        browser.stateUpdateHandler = { state in
            // Delivered on the queue passed to `start(queue:)` below (main).
            MainActor.assumeIsolated {
                if case .failed = state {
                    onEvent(.failed)
                }
            }
        }

        browser.browseResultsChangedHandler = { results, _ in
            let mapped = results.map(Self.mapResult)
            MainActor.assumeIsolated {
                onEvent(.results(mapped))
            }
        }

        browser.start(queue: .main)
    }

    public func cancel() {
        browser?.cancel()
        browser = nil
    }

    private static func mapResult(_ result: NWBrowser.Result) -> MomoServerDiscoveryResult {
        var serviceName = ""
        if case let .service(name, _, _, _) = result.endpoint {
            serviceName = name
        }
        var baseURLString: String?
        if case let .bonjour(txtRecord) = result.metadata,
           case let .string(value) = txtRecord.getEntry(for: MomoServerDiscovery.txtBaseKey) {
            baseURLString = value
        }
        return MomoServerDiscoveryResult(serviceName: serviceName, baseURLString: baseURLString)
    }
}
