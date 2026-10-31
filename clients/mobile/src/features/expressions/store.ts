import {
  applyExpressionList,
  emptyExpressionCache,
} from '@momo/core/features/expressions/cache';
import {matchesExpressionContract} from '@momo/core/features/expressions/contracts';
import type {
  Expression,
  ExpressionList,
  ExpressionVariant,
} from '@momo/core/features/expressions/types';
import type {ExpressionTransport} from './transport';
import {
  emptyExpressionUsage,
  recordExpressionUse,
  restoreExpressionUsage,
  type ExpressionUsage,
} from '@momo/core/features/expressions/usage';
import {tokenizeExpressions} from '@momo/core/features/expressions/message';

export interface ExpressionFiles {
  write(key: string, bytes: Uint8Array): string;
  remove(uri: string): void;
}
export interface ExpressionSnapshot {
  items: readonly Expression[];
  state: 'loading' | 'ready' | 'error' | 'offline';
  revision: number;
  usage?: ExpressionUsage;
}

/** Owns metadata, pending downloads and temporary files for one signed-in scope. */
export function createPhoneExpressionStore(
  workspaceId: string,
  memberId: string,
  transport: ExpressionTransport,
  files: ExpressionFiles,
  storage?: {read(): unknown; write(value: ExpressionUsage): void},
) {
  const emptyItems: readonly Expression[] = [];
  let cache = emptyExpressionCache(workspaceId, memberId);
  let snapshot: ExpressionSnapshot = {
    items: emptyItems,
    state: 'loading',
    revision: 0,
  };
  let epoch = 0;
  let serial = 0;
  let online = true;
  let disposed = false;
  let usage = storage
    ? restoreExpressionUsage(storage.read(), workspaceId, memberId)
    : emptyExpressionUsage(workspaceId, memberId);
  const receipts = new Set<string>();
  const listeners = new Set<() => void>();
  const images = new Map<string, string>();
  const pending = new Map<string, Promise<string | null>>();
  const base = `/v1/workspaces/${encodeURIComponent(workspaceId)}/expressions`;
  const publish = (state = snapshot.state) => {
    snapshot = {
      items:
        state === 'ready' && cache.items.length > 0 ? cache.items : emptyItems,
      state,
      revision: epoch,
      usage,
    };
    listeners.forEach(listener => listener());
  };
  const evict = () => {
    epoch += 1;
    for (const uri of images.values()) files.remove(uri);
    images.clear();
    pending.clear();
  };
  const refresh = async (full = false): Promise<void> => {
    if (disposed || !online) return;
    if (full) {
      evict();
      cache = emptyExpressionCache(workspaceId, memberId);
      publish('loading');
    }
    const started = epoch;
    try {
      const response = await transport.request({
        method: 'GET',
        path: base + (cache.version === null ? '' : `?since=${cache.version}`),
      });
      if (disposed || started !== epoch) return;
      if (
        response.status !== 200 ||
        !matchesExpressionContract('List', response.json)
      )
        throw new Error('Expression list unavailable');
      const update = applyExpressionList(
        cache,
        response.json as ExpressionList,
      );
      if (update.needsFullRefresh) {
        if (full) throw new Error('Invalid expression snapshot');
        await refresh(true);
        return;
      }
      if (!update.applied) return;
      if (update.evictImageIds.length > 0) evict();
      cache = update.cache;
      publish('ready');
    } catch {
      if (!disposed && started === epoch) {
        evict();
        cache = emptyExpressionCache(workspaceId, memberId);
        publish('error');
      }
    }
  };
  return {
    start() {
      disposed = false;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => snapshot,
    refresh,
    recordSuccess(receipt: string, body: string) {
      if (disposed || receipts.has(receipt)) return;
      receipts.add(receipt);
      const ids = new Set(
        tokenizeExpressions(body, cache.items).flatMap(token =>
          token.type === 'expression' ? [token.expression.id] : [],
        ),
      );
      if (ids.size === 0) return;
      for (const id of ids) usage = recordExpressionUse(usage, id, Date.now());
      try { storage?.write(usage); } catch {
        // Device history is optional; a committed send/reaction remains successful.
      }
      publish();
    },
    /** A change notice revokes media immediately, before the delta arrives. */
    changed() {
      if (disposed || !online) return;
      evict();
      publish('loading');
      void refresh();
    },
    setOnline(value: boolean) {
      if (online === value) return;
      online = value;
      evict();
      cache = emptyExpressionCache(workspaceId, memberId);
      publish(value ? 'loading' : 'offline');
      if (value) void refresh(true);
    },
    async image(
      item: Pick<Expression, 'id' | 'name'>,
      variant: ExpressionVariant,
    ): Promise<string | null> {
      const current = cache.items.find(
        entry =>
          entry.id === item.id &&
          entry.name === item.name &&
          entry.status === 'active',
      );
      if (disposed || !online || snapshot.state !== 'ready' || !current?.media)
        return null;
      const media = current.media[variant];
      const key = `${item.id}/${variant}/${media.sha256}`;
      if (images.has(key)) return images.get(key)!;
      if (pending.has(key)) return pending.get(key)!;
      const started = epoch;
      const task = (async () => {
        try {
          const response = await transport.request({
            method: 'GET',
            path: `${base}/${encodeURIComponent(
              item.id,
            )}/image?size=${variant}&v=${media.sha256}`,
          });
          if (disposed || started !== epoch || response.status !== 200)
            return null;
          const bytes =
            response.bytes ??
            (response.bodyBase64 === undefined
              ? null
              : Uint8Array.from(atob(response.bodyBase64), char =>
                  char.charCodeAt(0),
                ));
          if (!bytes || bytes.length > media.bytes || bytes.length === 0)
            return null;
          const uri = files.write(
            `${++serial}.${media.mime === 'image/gif' ? 'gif' : 'png'}`,
            bytes,
          );
          images.set(key, uri);
          return uri;
        } catch {
          return null;
        } finally {
          if (started === epoch) pending.delete(key);
        }
      })();
      pending.set(key, task);
      return task;
    },
    dispose() {
      disposed = true;
      evict();
      cache = emptyExpressionCache(workspaceId, memberId);
      publish('offline');
      listeners.clear();
    },
  };
}
export type PhoneExpressionStore = ReturnType<
  typeof createPhoneExpressionStore
>;
