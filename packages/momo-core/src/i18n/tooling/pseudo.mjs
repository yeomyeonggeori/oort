// Development/test tool only. Not exported from the product i18n entry point.
import {TYPE} from '@formatjs/icu-messageformat-parser';
// Build-only parser exports let QA fixtures share the pinned parser without
// introducing a parser import into runtime TypeScript.
export {parse, TYPE} from '@formatjs/icu-messageformat-parser';

const ASCII = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ACCENT = 'áƀçďéƒğĥíĵķľɱñóƥɋŕšţúṽŵẋýžÁɃÇĎÉƑĞĤÍĴĶĽṀÑÓƤɊŔŠŢÚṼŴẊÝŽ';
const accents = new Map([...ASCII].map((letter, index) => [letter, [...ACCENT][index]]));

/** Only literals change; options, tags, arguments and skeletons keep their AST shape. */
export function pseudoCatalog(catalog) {
  let paddingRate = 0;
  let seen = 0;
  function literalLength(elements) {
    return elements.reduce((total, node) => total + (node.type === TYPE.literal ? [...node.value].length
      : node.type === TYPE.tag ? literalLength(node.children)
        : node.type === TYPE.select || node.type === TYPE.plural
          ? Object.values(node.options).reduce((sum, option) => sum + literalLength(option.value), 0) : 0), 0);
  }
  function transform(elements) {
    return elements.map(node => {
      if (node.type === TYPE.literal) {
        const letters = [...node.value].map(letter => accents.get(letter) ?? letter).join('');
        const before = Math.round(seen * paddingRate);
        seen += [...node.value].length;
        return {...node, value: letters + '~'.repeat(Math.round(seen * paddingRate) - before)};
      }
      if (node.type === TYPE.tag) return {...node, children: transform(node.children)};
      if (node.type === TYPE.select || node.type === TYPE.plural) {
        return {...node, options: Object.fromEntries(Object.entries(node.options)
          .map(([selector, option]) => [selector, {...option, value: transform(option.value)}]))};
      }
      return structuredClone(node);
    });
  }
  return Object.fromEntries(Object.entries(catalog).map(([key, ast]) => {
    const length = literalLength(ast);
    // Include both bracket markers in the +35% budget. Tiny strings have an
    // unavoidable integer/marker rounding error; never drop their markers.
    paddingRate = length ? Math.max(0, Math.round(length * 0.35) - 2) / length : 0;
    seen = 0;
    return [key, [{type: TYPE.literal, value: '['}, ...transform(ast), {type: TYPE.literal, value: ']'}]];
  }));
}
