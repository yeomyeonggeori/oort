/* eslint-env node, es2022 */
// ADR-0213 §8 / #4833. Source of truth: mobile.ios.* in the shared ko/en catalogs.
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mapping = {
  NSCameraUsageDescription: 'mobile.ios.cameraUsage',
  NSFaceIDUsageDescription: 'mobile.ios.faceIdUsage',
  NSLocalNetworkUsageDescription: 'mobile.ios.localNetworkUsage',
  NSMicrophoneUsageDescription: 'mobile.ios.microphoneUsage',
  NSPhotoLibraryUsageDescription: 'mobile.ios.photoLibraryUsage',
  NSPhotoLibraryAddUsageDescription: 'mobile.ios.photoLibraryAddUsage',
};
const locales = {'en-US': 'en', 'ko-KR': 'ko'};
const plist = readFileSync(resolve(mobile, 'ios/MomoMobile/Info.plist'), 'utf8');
const project = readFileSync(resolve(mobile, 'ios/MomoMobile.xcodeproj/project.pbxproj'), 'utf8');
const keys = [...plist.matchAll(/<key>(NS\w+UsageDescription)<\/key>/g)].map(match => match[1]).sort();
if (JSON.stringify(keys) !== JSON.stringify(Object.keys(mapping).sort())) {
  throw new Error('Permission key mapping must cover every Info.plist usage description exactly.');
}
const regions = project.match(/knownRegions = \(([\s\S]*?)\);/)?.[1];
if (!regions || !/developmentRegion = en;/.test(project)
  || !/InfoPlist.strings in Resources/.test(project)) throw new Error('Missing Xcode localization resources.');
for (const [locale, region] of Object.entries(locales)) {
  if (!new RegExp(`\\b${region},`).test(regions) || !project.includes(`MomoMobile/${region}.lproj/InfoPlist.strings`)) {
    throw new Error(`Xcode region/resource is missing: ${region}`);
  }
  const catalog = JSON.parse(readFileSync(resolve(mobile, `../../packages/momo-core/src/i18n/catalogs/${locale}/mobile.json`), 'utf8'));
  const lines = Object.entries(mapping).map(([key, id]) => {
    const text = catalog[id];
    if (typeof text !== 'string' || !text.trim() || /[{}<>]/.test(text)) throw new Error(`Invalid plain permission string: ${id}`);
    return `${JSON.stringify(key)} = ${JSON.stringify(text)};`;
  });
  const output = `/* Generated from @momo/core/i18n/catalogs/${locale}/mobile.json. Do not edit. */\n${lines.join('\n')}\n`;
  const path = resolve(mobile, `ios/MomoMobile/${region}.lproj/InfoPlist.strings`);
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== output) throw new Error(`Stale InfoPlist.strings: ${region}`);
  } else {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, output);
  }
}
console.log(`InfoPlist.strings ${process.argv.includes('--check') ? 'check' : 'generate'}: ko/en PASS`);
