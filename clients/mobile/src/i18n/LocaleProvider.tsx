import {SAFE_MESSAGE} from '@momo/core/i18n/service';
import React, {createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {OortLoader} from '../design/brand/OortLoader';
import {font, line, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../design/tokens';
import {useStyles} from '../design/theme';
import {createMobileLocaleController, type MobileLocaleController, type MobileLocaleSnapshot} from './controller';
import {subscribeMobileLocaleChanges} from './device';
import {createMobileLocalePort} from './preferencePort';

interface MobileLocaleValue extends MobileLocaleSnapshot {
  controller: MobileLocaleController;
}
const LocaleContext = createContext<MobileLocaleValue | null>(null);

function createInstallationLocale(): Promise<MobileLocaleController> {
  return createMobileLocaleController({port: createMobileLocalePort(), observeDevice: subscribeMobileLocaleChanges});
}

/** Above session/workspace providers: language switches never remount or clear those scopes. */
export function MobileLocaleProvider({children, createController = createInstallationLocale}: {
  children: React.ReactNode;
  createController?: () => Promise<MobileLocaleController>;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const [controller, setController] = useState<MobileLocaleController | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    let active: MobileLocaleController | undefined;
    setCode(null);
    void createController().then(next => {
      if (disposed) { next.dispose(); return; }
      active = next;
      setController(next);
    }).catch(error => {
      if (disposed) return;
      // No exception text/native data reaches the UI, even for a broken host.
      setCode(error instanceof Error && error.message === 'mobile-intl-initialization-failed'
        ? 'mobile-intl-initialization-failed' : 'mobile-locale-initialization-failed');
    });
    return () => { disposed = true; active?.dispose(); };
  }, [createController, attempt]);
  if (controller) return <ReadyLocale controller={controller}>{children}</ReadyLocale>;
  return (
    <View style={styles.boot} testID="locale-boot">
      {code ? (
        <View accessibilityLanguage="en-US" style={styles.failure}>
          {/* The catalog-independent core safe message is also the retry action. */}
          <Pressable accessibilityRole="button" onPress={() => setAttempt(value => value + 1)} style={styles.retry}>
            <Text style={styles.message}>{SAFE_MESSAGE}</Text>
          </Pressable>
          <Text selectable style={styles.code} testID="locale-boot-code">{code}</Text>
        </View>
      ) : <OortLoader testID="locale-boot-loading" />}
    </View>
  );
}

function ReadyLocale({controller, children}: {controller: MobileLocaleController; children: React.ReactNode}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const value = useMemo(() => ({...snapshot, controller}), [snapshot, controller]);
  return (
    <LocaleContext.Provider value={value}>
      <View style={styles.fill} accessibilityLanguage={snapshot.effectiveLocale}>{children}</View>
    </LocaleContext.Provider>
  );
}

/** Optional for existing isolated screen harnesses; product App always installs the provider. */
export function useMobileLocale(): MobileLocaleValue | null {
  return useContext(LocaleContext);
}

const buildStyles = (color: Palette) => StyleSheet.create({
  fill: {flex: 1},
  boot: {flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: color.bg, padding: SAFE_GUTTER},
  failure: {gap: space.sm, alignItems: 'center'},
  retry: {minHeight: TOUCH_TARGET, padding: space.md, justifyContent: 'center'},
  message: {fontSize: font.body, lineHeight: line.body, color: color.text, textAlign: 'center'},
  code: {fontSize: font.label, lineHeight: line.label, color: color.textMuted, textAlign: 'center'},
});
