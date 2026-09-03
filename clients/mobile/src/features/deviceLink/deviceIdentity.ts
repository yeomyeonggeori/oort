import * as Device from 'expo-device';
import {Platform} from 'react-native';

/** OpenAPI DeviceLinkDevice.name: 1..64 characters after trim. */
const DEVICE_NAME_MAX = 64;

function idiomFallback(): string {
  const constants = Platform.constants as {
    systemName?: string;
    interfaceIdiom?: string;
  };
  const idiom = constants.interfaceIdiom;
  const model =
    idiom === 'pad' ? 'iPad' : idiom === 'tv' ? 'Apple TV' : 'iPhone';
  const os =
    typeof constants.systemName === 'string' && constants.systemName.trim() !== ''
      ? constants.systemName.trim()
      : 'iOS';
  const raw = `${model} (${os})`.trim();
  return raw === '' ? 'iPhone (iOS)' : raw;
}

/**
 * Redeem body `device`. Prefers `expo-device` `modelName` (e.g. "iPhone 17 Pro");
 * falls back to `"<idiom> (<systemName>)"` when the OS does not name the model.
 * Two identical models stay indistinguishable — accepted residual.
 */
export function deviceLinkDevice(): {name: string; platform: 'ios'} {
  const fromOs =
    typeof Device.modelName === 'string' && Device.modelName.trim() !== ''
      ? Device.modelName.trim()
      : idiomFallback();
  const name = fromOs.slice(0, DEVICE_NAME_MAX);
  return {name: name === '' ? 'iPhone (iOS)' : name, platform: 'ios'};
}
