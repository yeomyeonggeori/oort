import {act, type ReactElement} from 'react';
import {createRoot} from 'react-dom/client';
import {getByRole, type ByRoleMatcher} from '@testing-library/react';
import {createFlush, createMount} from '@momo/core/testkit';

export {createCopy, member, message, loginBody, selfMember} from '@momo/core/testkit';

const mounts = createMount((ui: ReactElement) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(ui));
  return {host, root};
}, ({host, root}) => {
  act(() => root.unmount());
  host.remove();
});

/** Call cleanupMounts in afterEach. The test owns the React act environment. */
export const mount = (ui: ReactElement): HTMLElement => mounts.mount(ui).host;
export const cleanupMounts = mounts.cleanup;
export const flush = createFlush(async (work) => { await act(work); });

/** Scoped role query with a required, nonblank accessible name. */
export function control(host: HTMLElement, role: ByRoleMatcher, name: string | RegExp): HTMLElement {
  if (name === undefined || (typeof name === 'string' && name.trim() === '')) {
    throw new Error('Empty control name');
  }
  return getByRole(host, role, {name});
}
