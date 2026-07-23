import Foundation
import Testing
@testable import MomoMetrics

@Test func prometheusTextUsesClosedAPNSLabelValues() async {
    let registry = await MetricsRegistry.pushRelay()
    await registry.incrementLabeledCounter(
        name: MomoMetricName.apnsFailuresTotal,
        labelValue: APNSFailureCodeClass.rateLimited.rawValue
    )

    let text = await registry.render()
    #expect(text.contains("# TYPE momo_apns_failures_total counter"))
    #expect(text.contains("momo_apns_failures_total{code_class=\"429\"} 1"))
    for codeClass in APNSFailureCodeClass.allCases {
        #expect(text.contains("code_class=\"\(codeClass.rawValue)\""))
    }
    #expect(!text.contains("workspace_id"))
    #expect(!text.contains("run_id"))
    #expect(!text.contains("member_id"))
}

@Test func histogramRendersCumulativeBuckets() async {
    let registry = await MetricsRegistry.agentWorker()
    await registry.observeHistogram(
        name: MomoMetricName.agentTurnDurationSeconds,
        value: 0.2
    )
    await registry.observeHistogram(
        name: MomoMetricName.agentTurnDurationSeconds,
        value: 3
    )

    let text = await registry.render()
    #expect(text.contains(
        "momo_agent_turn_duration_seconds_bucket{le=\"0.25\"} 1"
    ))
    #expect(text.contains(
        "momo_agent_turn_duration_seconds_bucket{le=\"5\"} 2"
    ))
    #expect(text.contains("momo_agent_turn_duration_seconds_count 2"))
}

@Test func APNSStatusClassificationIsBounded() {
    #expect(APNSFailureCodeClass.classify(status: 200) == nil)
    #expect(APNSFailureCodeClass.classify(status: 400) == .badRequest)
    #expect(APNSFailureCodeClass.classify(status: 410) == .unregistered)
    #expect(APNSFailureCodeClass.classify(status: 429) == .rateLimited)
    #expect(APNSFailureCodeClass.classify(status: 403) == .otherClientError)
    #expect(APNSFailureCodeClass.classify(status: 503) == .serverError)
}
