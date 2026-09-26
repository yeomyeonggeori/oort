import {useCallback, useState} from 'react';
import {NON_SECRET_KEYS, nonSecretStore} from '../../storage/kv';
import type {SidebarRow, SidebarSection} from '../sidebar/rows';

// =============================================================================
// 홈 섹션 접기 — 사람의 선택을 기기에 남긴다 (DS2-3 #2715).
//
// 시안 A `.a-sec-h` 의 셰브론이 섹션을 접는다. 접은 상태는 앱을 다시 열어도 남는다:
// 매번 펼쳐져 돌아오는 섹션은 「접기」가 아니라 「잠깐 숨기기」다.
//
// ## 접혀도 안 읽은 행은 남는다
//
// 접은 섹션이 안 읽은 대화까지 삼키면 멘션이 화면에서 사라진다 — 사람은 접은 것이
// 목록이지 알림이 아니다. 그래서 접힌 섹션은 **안 읽음·멘션이 있는 행과 지금 열린
// 행**만 남긴다. Slack 의 접힌 섹션이 같은 규칙이다.
// =============================================================================

type SectionKey = SidebarSection['key'];

/** 저장값 → 워크스페이스별 접힌 키. 망가진 값은 빈 표로 읽는다(펼침이 기본). */
export function parseCollapsed(raw: string | undefined): Record<string, SectionKey[]> {
  if (raw === undefined) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, SectionKey[]> = {};
    for (const [workspace, keys] of Object.entries(value as Record<string, unknown>)) {
      if (!Array.isArray(keys)) continue;
      out[workspace] = keys.filter(
        (key): key is SectionKey => key === 'channels' || key === 'dms',
      );
    }
    return out;
  } catch {
    return {};
  }
}

/** 접힌 섹션이 그래도 보이는 행. 펼친 섹션은 그대로다. */
export function visibleRows(
  section: SidebarSection,
  collapsed: boolean,
  isOpen: (row: SidebarRow) => boolean,
): SidebarRow[] {
  if (!collapsed) return section.data;
  return section.data.filter(
    row => row.unreadCount > 0 || row.mentionCount > 0 || isOpen(row),
  );
}

/** 이 워크스페이스에서 접힌 섹션과, 한 섹션을 뒤집는 함수. */
export function useCollapsedSections(workspaceId: string): {
  collapsed: ReadonlySet<SectionKey>;
  toggle: (key: SectionKey) => void;
} {
  const [collapsed, setCollapsed] = useState<ReadonlySet<SectionKey>>(
    () =>
      new Set(
        parseCollapsed(
          nonSecretStore().getString(NON_SECRET_KEYS.homeCollapsedSections),
        )[workspaceId] ?? [],
      ),
  );
  const toggle = useCallback(
    (key: SectionKey) => {
      setCollapsed(previous => {
        const next = new Set(previous);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        const store = nonSecretStore();
        const all = parseCollapsed(
          store.getString(NON_SECRET_KEYS.homeCollapsedSections),
        );
        all[workspaceId] = [...next];
        store.set(NON_SECRET_KEYS.homeCollapsedSections, JSON.stringify(all));
        return next;
      });
    },
    [workspaceId],
  );
  return {collapsed, toggle};
}
