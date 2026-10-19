import type {PluginCatalogItem, PluginDetail, PluginPolicyTool} from '@momo/core/lib/api';
import {
  phoneAppDetail,
  phoneAppRows,
} from '@momo/core/features/plugins/phoneApps';
import React from 'react';
import {Screen} from '../src/design/atoms';
import {AppDetailView} from '../src/screens/AppDetailScreen';
import {AppsView, type AppsViewState} from '../src/screens/AppsScreen';

// =============================================================================
// 「앱」 읽기 화면 캡처 표면 (U-4 #3951). 실제 `AppsView`·`AppDetailView` 를 세운다 — 서버 없이 순수 표현부에
// 픽스처를 넣는다(훅이 하는 일은 `appsPhone.test.tsx` 가 잰다).
//
//   xcrun simctl launch <udid> app.momo.ios --args -momoMeasure APPS-<which>
//   (라이트: LIGHT-APPS-<which>)
//
// which: list · list-empty · list-loading · list-error · list-absent · list-offline
//        detail-blocked · detail-allowed · detail-error · detail-loading
// =============================================================================

const BASE: Omit<PluginCatalogItem, 'pluginId' | 'name' | 'description' | 'egressDomains'> = {
  version: '1.0.0',
  official: true,
  recommended: true,
  recommendedFor: [],
  installed: true,
  enabled: true,
};

const GITHUB: PluginCatalogItem = {
  ...BASE,
  pluginId: 'com.momo.plugins.github',
  name: 'GitHub',
  description: 'Official GitHub hosted MCP integration',
  egressDomains: ['api.githubcopilot.com'],
};
const NOTION: PluginCatalogItem = {
  ...BASE,
  pluginId: 'com.momo.plugins.notion',
  name: 'Notion',
  description: 'Official Notion hosted MCP integration',
  egressDomains: ['mcp.notion.com'],
};
const LINEAR: PluginCatalogItem = {
  ...BASE,
  pluginId: 'com.momo.plugins.linear',
  name: 'Linear',
  description: 'Official Linear hosted MCP integration',
  egressDomains: ['mcp.linear.app'],
  installed: false,
  enabled: false,
};
const DRIVE: PluginCatalogItem = {
  ...BASE,
  pluginId: 'com.momo.plugins.drive',
  name: 'Google Drive',
  description: 'Team shared drive',
  egressDomains: ['www.googleapis.com'],
  enabled: false,
};

const READ: PluginPolicyTool = {name: 'github.list_issues', risk: 'read', approvalTier: 'read_only'};
const READ2: PluginPolicyTool = {name: 'github.get_issue', risk: 'read', approvalTier: 'read_only'};

const POLICY = new Map<string, PluginPolicyTool[]>([
  [GITHUB.pluginId, [READ, READ2]],
  [NOTION.pluginId, []],
]);

const ROWS = phoneAppRows([GITHUB, NOTION, DRIVE, LINEAR], POLICY);

const GITHUB_DETAIL: PluginDetail = {
  ...GITHUB,
  publisherName: 'GitHub',
  publisherVerified: true,
  license: 'MIT',
  tools: [
    {name: 'github.list_issues', description: '이슈 목록 읽기', scopes: ['issues:read'], risk: 'read', approvalTier: 'read_only'},
    {name: 'github.get_issue', description: '이슈 하나 읽기', scopes: ['issues:read'], risk: 'read', approvalTier: 'read_only'},
    {name: 'github.create_issue', description: '이슈 만들기', scopes: ['issues:write'], risk: 'write', approvalTier: 'network_write'},
    {name: 'github.add_comment', description: '댓글 달기', scopes: ['issues:comment'], risk: 'write', approvalTier: 'workspace_write'},
  ],
};
const NOTION_DETAIL: PluginDetail = {
  ...NOTION,
  publisherName: 'Notion',
  publisherVerified: true,
  license: 'MIT',
  tools: [
    {name: 'notion.search', description: '페이지 찾기', scopes: ['pages:read'], risk: 'read', approvalTier: 'read_only'},
    {name: 'notion.update_page', description: '페이지 고치기', scopes: ['pages:write'], risk: 'write', approvalTier: 'workspace_write'},
  ],
};

const NOOP = () => {};

export function AppsSurface({which}: {which: string}): React.JSX.Element {
  if (which.startsWith('detail')) {
    const allowed = which === 'detail-allowed';
    const state = which === 'detail-error' ? 'error' : which === 'detail-loading' ? 'loading' : 'ready';
    return (
      <Screen>
        <AppDetailView
          title={allowed ? 'GitHub' : 'Notion'}
          state={state}
          view={
            state === 'ready'
              ? allowed
                ? phoneAppDetail(GITHUB_DETAIL, [READ, READ2])
                : phoneAppDetail(NOTION_DETAIL, [])
              : undefined
          }
          policyKnown
          offline={false}
          webUrl="https://oort.example/settings?section=plugins"
          onBack={NOOP}
          onRetry={NOOP}
          onOpenWeb={NOOP}
        />
      </Screen>
    );
  }
  const state: AppsViewState =
    which === 'list-loading'
      ? 'loading'
      : which === 'list-error'
        ? 'error'
        : which === 'list-absent'
          ? 'absent'
          : 'ready';
  return (
    <AppsView
      state={state}
      rows={which === 'list-empty' ? [] : ROWS}
      offline={which === 'list-offline'}
      staleAtMs={Date.now() - 12 * 60_000}
      onBack={NOOP}
      onRetry={NOOP}
      onOpenApp={NOOP}
    />
  );
}
