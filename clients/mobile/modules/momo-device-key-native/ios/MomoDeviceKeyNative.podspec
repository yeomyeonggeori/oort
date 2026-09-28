Pod::Spec.new do |s|
  s.name           = 'MomoDeviceKeyNative'
  s.version        = '1.0.0'
  s.summary        = 'Secure Enclave P-256 human device key for the oort iOS client.'
  s.description    = 'Creates, signs with and deletes a Secure Enclave P-256 key guarded by ' \
                     'biometryCurrentSet and stored in an app-only keychain access group ' \
                     '(ADR-0146, 2026-09-28 revision). The private key never leaves the enclave.'
  s.author         = 'oort'
  s.homepage       = 'https://oor7.com'
  s.license        = { :type => 'Apache-2.0', :text => 'See LICENSE at the repository root.' }
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CryptoKit', 'LocalAuthentication', 'Security'

  s.source_files = '**/*.{h,m,mm,swift}'
end
