import type {ImageSourcePropType} from 'react-native';

// Lucide Smile (ISC, existing NOTICE). Same raster recipe as index.ts:
// viewBox 24, stroke 1.8, round caps/joins; 20pt toolbar icon at 1/2/3x.
export const EXPRESSION_ICONS = {
  smile: require('./smile20.png') as ImageSourcePropType,
} as const;
