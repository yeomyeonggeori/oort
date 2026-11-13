// Development/test tool only. Not exported from the product i18n entry point.
// Build-only parser exports let QA fixtures share the pinned parser without
// introducing a parser import into runtime TypeScript.
export {parse, TYPE} from '@formatjs/icu-messageformat-parser';
// The transform itself lives in `../pseudo.ts` (no parser import), so a development build can use it too (#5589).
export {pseudoCatalog} from '../pseudo.ts';
