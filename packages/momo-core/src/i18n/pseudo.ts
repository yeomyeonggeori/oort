import type { MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import type { MessageCatalog } from './types';

/**
 * Pseudo locale `en-XA` (ADR-0213 §4, #4834 → #5589). Development and capture builds only: it is
 * not exported from the `@momo/core/i18n` barrel, no language list offers it, and hosts import it
 * behind a build-time flag so production bundles drop it.
 *
 * Only literals change. Each message gains `[` `]` boundaries and ~35% length (markers included),
 * letters are accented, and arguments, plural/select options, tags, pound and number/date
 * skeletons keep their AST shape. Text on screen without the brackets did not come from the
 * dictionary.
 */
export const PSEUDO_LOCALE = 'en-XA';

// The parser's TYPE enum values (`@formatjs/icu-messageformat-parser`), read here as plain numbers
// so the runtime never loads the parser. `pseudo.test.ts` pins them against the parser itself.
export const AST_TYPE = Object.freeze({ literal: 0, select: 5, plural: 6, tag: 8 });

const ASCII = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ACCENT = 'áƀçďéƒğĥíĵķľɱñóƥɋŕšţúṽŵẋýžÁɃÇĎÉƑĞĤÍĴĶĽṀÑÓƤɊŔŠŢÚṼŴẊÝŽ';
const accents = new Map([...ASCII].map((letter, index) => [letter, [...ACCENT][index]]));

type Options = Record<string, { value: MessageFormatElement[] }>;
const optionsOf = (node: MessageFormatElement): Options | undefined =>
  node.type === AST_TYPE.select || node.type === AST_TYPE.plural ? (node as unknown as { options: Options }).options : undefined;
const childrenOf = (node: MessageFormatElement): MessageFormatElement[] | undefined =>
  node.type === AST_TYPE.tag ? (node as unknown as { children: MessageFormatElement[] }).children : undefined;

function literalLength(elements: MessageFormatElement[]): number {
  return elements.reduce((total, node) => {
    if (node.type === AST_TYPE.literal) return total + [...(node as { value: string }).value].length;
    const children = childrenOf(node);
    if (children) return total + literalLength(children);
    const options = optionsOf(node);
    return options ? total + Object.values(options).reduce((sum, option) => sum + literalLength(option.value), 0) : total;
  }, 0);
}

/** Transforms a compiled catalog; the input is not modified. */
export function pseudoCatalog(catalog: MessageCatalog): MessageCatalog {
  let paddingRate = 0;
  let seen = 0;
  let emitted = 0;
  const pad = () => {
    const count = Math.max(0, Math.round(seen * paddingRate) - emitted);
    emitted += count;
    return '~'.repeat(count);
  };
  function transform(elements: MessageFormatElement[]): MessageFormatElement[] {
    return elements.map(node => {
      if (node.type === AST_TYPE.literal) {
        // Padding goes at word ends, so a long message still wraps where a translation would:
        // one unbroken run of `~` would report overflow that no real language causes.
        const value = (node as { value: string }).value.split(/(\s+)/).map(part => {
          seen += [...part].length;
          if (!part || /^\s+$/.test(part)) return part;
          return [...part].map(letter => accents.get(letter) ?? letter).join('') + pad();
        }).join('');
        return { ...node, value } as MessageFormatElement;
      }
      const children = childrenOf(node);
      if (children) return { ...node, children: transform(children) } as MessageFormatElement;
      const options = optionsOf(node);
      if (options) {
        return { ...node, options: Object.fromEntries(Object.entries(options)
          .map(([selector, option]) => [selector, { ...option, value: transform(option.value) }])) } as MessageFormatElement;
      }
      return JSON.parse(JSON.stringify(node)) as MessageFormatElement;
    });
  }
  const literal = (value: string) => ({ type: AST_TYPE.literal, value }) as MessageFormatElement;
  return Object.fromEntries(Object.entries(catalog).map(([key, ast]) => {
    const length = literalLength(ast);
    // Include both bracket markers in the +35% budget. Tiny strings have an
    // unavoidable integer/marker rounding error; never drop their markers.
    paddingRate = length ? Math.max(0, Math.round(length * 0.35) - 2) / length : 0;
    seen = 0;
    emitted = 0;
    const body = transform(ast);
    // Whitespace at the very end has no word to carry its share; it goes just inside the closing marker.
    const rest = pad();
    return [key, [literal('['), ...body, ...(rest ? [literal(rest)] : []), literal(']')]];
  }));
}
