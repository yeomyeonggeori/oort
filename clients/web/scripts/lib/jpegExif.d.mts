export function exifSegment(options?: { orientation?: number; gps?: { lat: [number, number, number]; lon: [number, number, number] } }): Uint8Array;
export function injectExif(jpeg: Uint8Array, segment: Uint8Array): Uint8Array;

export interface JpegInfo {
  isJpeg: boolean;
  width: number;
  height: number;
  exif: boolean;
  gps: boolean;
  orientation: number | null;
  markers: string[];
}

export function inspectJpeg(bytes: Uint8Array): JpegInfo;
