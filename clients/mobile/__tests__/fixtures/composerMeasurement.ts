import {fireEvent, screen} from '@testing-library/react-native';
import {StyleSheet} from 'react-native';

/** Jest has no native glyph layout. Report the independent Text mirror's result. */
export function measureComposerText(textHeight: number, work = false): void {
  const input = screen.getByTestId(work ? 'work-chat-input' : 'composer-input');
  fireEvent(input, 'layout', {nativeEvent: {layout: {
    x: 0, y: 0, width: 280, height: StyleSheet.flatten(input.props.style).height,
  }}});
  const mirror = screen.getByTestId(work ? 'work-chat-content-mirror' : 'composer-content-mirror', {
    includeHiddenElements: true,
  });
  fireEvent(mirror, 'textLayout', {nativeEvent: {lines: [{height: textHeight}]}});
}
