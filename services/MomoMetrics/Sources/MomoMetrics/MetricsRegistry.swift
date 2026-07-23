import Foundation

public enum MomoMetricName {
    public static let outboxPendingOldestAgeSeconds =
        "momo_outbox_pending_oldest_age_seconds"
    public static let budgetTripsTotal = "momo_budget_trips_total"
    public static let apnsFailuresTotal = "momo_apns_failures_total"
    public static let agentTurnDurationSeconds = "momo_agent_turn_duration_seconds"
    public static let outboxPublishLatencySeconds =
        "momo_outbox_publish_latency_seconds"
}

public enum APNSFailureCodeClass: String, CaseIterable, Sendable {
    case badRequest = "400"
    case unregistered = "410"
    case rateLimited = "429"
    case otherClientError = "other_4xx"
    case serverError = "5xx"
    case transportError = "transport"

    public static func classify(status: Int) -> APNSFailureCodeClass? {
        switch status {
        case 200..<400:
            nil
        case 400:
            .badRequest
        case 410:
            .unregistered
        case 429:
            .rateLimited
        case 401..<500:
            .otherClientError
        case 500...:
            .serverError
        default:
            .transportError
        }
    }
}

public actor MetricsRegistry {
    public struct HistogramDefinition: Sendable {
        public let name: String
        public let help: String
        public let buckets: [Double]

        public init(name: String, help: String, buckets: [Double]) {
            precondition(!buckets.isEmpty)
            precondition(buckets == buckets.sorted())
            self.name = name
            self.help = help
            self.buckets = buckets
        }
    }

    private struct HistogramState: Sendable {
        let definition: HistogramDefinition
        var bucketCounts: [UInt64]
        var count: UInt64 = 0
        var sum: Double = 0
    }

    private var gauges: [String: (help: String, value: Double)] = [:]
    private var counters: [String: (help: String, value: UInt64)] = [:]
    private var labeledCounters: [
        String: (help: String, labelName: String, values: [String: UInt64])
    ] = [:]
    private var histograms: [String: HistogramState] = [:]

    public init() {}

    public func registerGauge(name: String, help: String, initialValue: Double = 0) {
        Self.requireValidMetricName(name)
        gauges[name] = (help, initialValue)
    }

    public func setGauge(name: String, value: Double) {
        guard let existing = gauges[name] else {
            preconditionFailure("unregistered gauge: \(name)")
        }
        gauges[name] = (existing.help, max(0, value))
    }

    public func registerCounter(name: String, help: String) {
        Self.requireValidMetricName(name)
        counters[name] = (help, 0)
    }

    public func incrementCounter(name: String, by amount: UInt64 = 1) {
        guard let existing = counters[name] else {
            preconditionFailure("unregistered counter: \(name)")
        }
        counters[name] = (existing.help, existing.value &+ amount)
    }

    public func registerLabeledCounter(
        name: String,
        help: String,
        labelName: String,
        allowedValues: [String]
    ) {
        Self.requireValidMetricName(name)
        precondition(!allowedValues.isEmpty)
        precondition(Set(allowedValues).count == allowedValues.count)
        labeledCounters[name] = (
            help,
            labelName,
            Dictionary(uniqueKeysWithValues: allowedValues.map { ($0, 0) })
        )
    }

    public func incrementLabeledCounter(
        name: String,
        labelValue: String,
        by amount: UInt64 = 1
    ) {
        guard var existing = labeledCounters[name] else {
            preconditionFailure("unregistered labeled counter: \(name)")
        }
        guard let value = existing.values[labelValue] else {
            preconditionFailure("unbounded label value for \(name): \(labelValue)")
        }
        existing.values[labelValue] = value &+ amount
        labeledCounters[name] = existing
    }

    public func registerHistogram(_ definition: HistogramDefinition) {
        Self.requireValidMetricName(definition.name)
        histograms[definition.name] = HistogramState(
            definition: definition,
            bucketCounts: Array(repeating: 0, count: definition.buckets.count)
        )
    }

    public func observeHistogram(name: String, value: Double) {
        guard var state = histograms[name] else {
            preconditionFailure("unregistered histogram: \(name)")
        }
        let sample = max(0, value)
        for index in state.definition.buckets.indices
            where sample <= state.definition.buckets[index]
        {
            state.bucketCounts[index] &+= 1
        }
        state.count &+= 1
        state.sum += sample
        histograms[name] = state
    }

    public func render() -> String {
        var lines = ["# momo Prometheus metrics (content-free, bounded-cardinality)"]

        for name in gauges.keys.sorted() {
            guard let metric = gauges[name] else { continue }
            lines.append("# HELP \(name) \(Self.escapeHelp(metric.help))")
            lines.append("# TYPE \(name) gauge")
            lines.append("\(name) \(Self.format(metric.value))")
        }
        for name in counters.keys.sorted() {
            guard let metric = counters[name] else { continue }
            lines.append("# HELP \(name) \(Self.escapeHelp(metric.help))")
            lines.append("# TYPE \(name) counter")
            lines.append("\(name) \(metric.value)")
        }
        for name in labeledCounters.keys.sorted() {
            guard let metric = labeledCounters[name] else { continue }
            lines.append("# HELP \(name) \(Self.escapeHelp(metric.help))")
            lines.append("# TYPE \(name) counter")
            for labelValue in metric.values.keys.sorted() {
                let value = metric.values[labelValue] ?? 0
                lines.append(
                    "\(name){\(metric.labelName)=\"\(Self.escapeLabel(labelValue))\"} \(value)"
                )
            }
        }
        for name in histograms.keys.sorted() {
            guard let state = histograms[name] else { continue }
            lines.append("# HELP \(name) \(Self.escapeHelp(state.definition.help))")
            lines.append("# TYPE \(name) histogram")
            for index in state.definition.buckets.indices {
                lines.append(
                    "\(name)_bucket{le=\"\(Self.format(state.definition.buckets[index]))\"} "
                        + "\(state.bucketCounts[index])"
                )
            }
            lines.append("\(name)_bucket{le=\"+Inf\"} \(state.count)")
            lines.append("\(name)_sum \(Self.format(state.sum))")
            lines.append("\(name)_count \(state.count)")
        }
        return lines.joined(separator: "\n") + "\n"
    }

    private static func requireValidMetricName(_ name: String) {
        precondition(name.hasPrefix("momo_"))
        precondition(
            name.hasSuffix("_seconds")
                || name.hasSuffix("_total")
        )
    }

    private static func escapeHelp(_ value: String) -> String {
        value.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\n", with: "\\n")
    }

    private static func escapeLabel(_ value: String) -> String {
        value.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }

    private static func format(_ value: Double) -> String {
        if value == Double(Int64(value)) {
            return String(Int64(value))
        }
        return String(format: "%.9g", locale: Locale(identifier: "en_US_POSIX"), value)
    }
}

public extension MetricsRegistry {
    static func api() -> MetricsRegistry {
        MetricsRegistry()
    }

    static func outboxRelay() async -> MetricsRegistry {
        let registry = MetricsRegistry()
        await registry.registerGauge(
            name: MomoMetricName.outboxPendingOldestAgeSeconds,
            help: "Age in seconds of the oldest pending broadcast outbox row."
        )
        await registry.registerHistogram(.init(
            name: MomoMetricName.outboxPublishLatencySeconds,
            help: "Seconds from outbox commit to successful Centrifugo publish.",
            buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
        ))
        return registry
    }

    static func agentWorker() async -> MetricsRegistry {
        let registry = MetricsRegistry()
        await registry.registerCounter(
            name: MomoMetricName.budgetTripsTotal,
            help: "Total agent turns rejected by the budget circuit breaker."
        )
        await registry.registerHistogram(.init(
            name: MomoMetricName.agentTurnDurationSeconds,
            help: "Seconds from mention enqueue to terminal agent turn response.",
            buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]
        ))
        return registry
    }

    static func pushRelay() async -> MetricsRegistry {
        let registry = MetricsRegistry()
        await registry.registerLabeledCounter(
            name: MomoMetricName.apnsFailuresTotal,
            help: "Total APNs delivery failures grouped into a closed status class.",
            labelName: "code_class",
            allowedValues: APNSFailureCodeClass.allCases.map(\.rawValue)
        )
        return registry
    }
}
