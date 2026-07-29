import CloudProviderKit
import Foundation

// ADR-0142 D2/D4 — the T3 provider contract now lives in CloudProviderKit and
// is compiled into both MomoServer and NotifierWorker. These aliases keep the
// existing MomoServer vocabulary (`CloudProvisionerConfig`) pointing at that
// one shared definition instead of re-declaring a second, drift-prone copy.
typealias CloudProvisionerConfig = CloudProviderSettings
typealias ReadyCloudProvisionerConfig = ReadyCloudProviderSettings
typealias CloudProvisionerError = CloudProviderError
typealias CloudProvisionerConfigError = CloudProviderConfigError
