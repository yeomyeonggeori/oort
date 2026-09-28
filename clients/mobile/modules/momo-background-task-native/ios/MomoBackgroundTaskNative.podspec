Pod::Spec.new do |s|
  s.name           = 'MomoBackgroundTaskNative'
  s.version        = '1.0.0'
  s.summary        = 'Finish a refresh-token rotation after the app leaves the foreground.'
  s.description    = 'begin/end around UIApplication.beginBackgroundTask, with an expiration ' \
                     'handler that ends the task itself when iOS runs out of patience. The ' \
                     'bookkeeping is a separate UIKit-free type so a simulator CLI can run it.'
  s.author         = 'oort'
  s.homepage       = 'https://oor7.com'
  s.license        = { :type => 'Apache-2.0', :text => 'See LICENSE at the repository root.' }
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,mm,swift}'
end
