Pod::Spec.new do |s|
  s.name           = 'MomoPushActionNative'
  s.version        = '1.0.0'
  s.summary        = 'Lock-screen approve/reject answered natively (ADR-0204 D6).'
  s.description    = 'A UNUserNotificationCenter delegate attached to expo-notifications at launch. ' \
                     'It holds a background task while one approval decision is sent with the ' \
                     'push_action token, then replaces the notification with a one-line local ' \
                     'result. The decision, its idempotency key and its result copy are UIKit-free ' \
                     'types so a simulator CLI can run them.'
  s.author         = 'oort'
  s.homepage       = 'https://oor7.com'
  s.license        = { :type => 'Apache-2.0', :text => 'See LICENSE at the repository root.' }
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'ExpoNotifications'

  s.source_files = '**/*.{h,m,mm,swift}'
end
