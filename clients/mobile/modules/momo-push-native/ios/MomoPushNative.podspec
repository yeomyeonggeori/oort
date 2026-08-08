Pod::Spec.new do |s|
  s.name           = 'MomoPushNative'
  s.version        = '1.0.0'
  s.summary        = 'Build-resolved push identifiers for the oort iOS client.'
  s.description    = 'Exposes MomoAPNSEnvironment and MomoKeychainAccessGroup from Info.plist to JS. ' \
                     'Both are $(BUILD_SETTING) values resolved at build time, so no JS-side constant ' \
                     'can be right for every configuration.'
  s.author         = 'oort'
  s.homepage       = 'https://oor7.com'
  s.license        = { :type => 'Apache-2.0', :text => 'See LICENSE at the repository root.' }
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,mm,swift}'
end
