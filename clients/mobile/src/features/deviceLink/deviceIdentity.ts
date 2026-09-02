import {Platform} from 'react-native';

/** OpenAPI DeviceLinkDevice.name: 1..64 characters after trim. */
const DEVICE_NAME_MAX = 64;

/**
 * Redeem body `device`. RN `Platform.constants` has no user-facing device
 * name (no model / expo-device), so this is `"<idiom> (<systemName>)"`.
 */
export function deviceLinkDevice(): {name: string; platform: 'ios'} {
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
  const name = raw.slice(0, DEVICE_NAME_MAX);
  return {name: name === '' ? 'iPhone (iOS)' : name, platform: 'ios'};
}
