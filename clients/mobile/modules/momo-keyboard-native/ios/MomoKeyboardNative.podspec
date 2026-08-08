Pod::Spec.new do |s|
  s.name           = 'MomoKeyboardNative'
  s.version        = '1.0.0'
  s.summary        = 'The conversation pane rises with the keyboard, from native code only.'
  s.description    = 'A UIKit view that observes UIKeyboardWillChangeFrameNotification and animates ' \
                     'its own transform with the keyboard\'s own duration and curve. Nothing about ' \
                     'the travel — start included — passes through the JavaScript thread. Also ' \
                     'records the travel natively, because a JS-side reading of a native animation ' \
                     'can only ever be an upper bound.'
  s.author         = 'oort'
  s.homepage       = 'https://oor7.com'
  s.license        = { :type => 'Apache-2.0', :text => 'See LICENSE at the repository root.' }
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,mm,swift}'
end
