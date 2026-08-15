import {
  hostedDetailView,
  hostedListRow,
} from '@momo/core/features/hostedAgents/status';
import {parseHostedConnectionDetail} from '@momo/core/features/hostedAgents/disconnect';
import {cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  HostedConnectionsView,
  type HostedRowItem,
} from '../src/screens/HostedConnectionsScreen';
import {HostedConnectionDetailView} from '../src/screens/HostedConnectionDetailScreen';

// =============================================================================
// #1359 HAP-UX3 — 폰의 읽기 전용 관전 표면.
//
// 순수 표현부(`*View`)를 props 로 그린다: 훅·네트워크·프로바이더 없이 상태 갈림·
// 비밀 노출·오프라인 결을 직접 검사한다. 판단과 문구는 코어(`status.test.ts`)가
// 덮고, 여기서는 그 판단이 화면에 정직하게 닿는지를 본다.
// =============================================================================

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';

function connectionWire(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CONNECTION_ID,
    agentMemberId: AGENT_ID,
    status: 'active',
    authMode: 'static_bearer',
    audience: '/v1/mcp/agent-port',
    approvedChannelIds: [],
    approvedScopes: ['agent:port:connect'],
    activeCredentialId: '33333333-3333-4333-8333-333333333333',
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_100_000,
    ...over,
  };
}

function listItem(over: Record<string, unknown> = {}): HostedRowItem {
  const connection = parseHostedConnectionDetail({
    connection: connectionWire(over),
  }).connection;
  return {row: hostedListRow(connection, '김인턴'), handle: 'kim-intern'};
}

afterEach(cleanup);

describe('list — the four states plus permission and offline', () => {
  const noop = () => {};

  it('draws a row with the status word and its sentence, and is one a11y element', () => {
    render(
      <HostedConnectionsView
        state="ready"
        rows={[listItem({status: 'detected', activeCredentialId: undefined})]}
        offline={false}
        onBack={noop}
        onRetry={noop}
        onOpenConnection={noop}
      />,
    );
    expect(screen.getByTestId(`hosted-row-chip-${CONNECTION_ID}`)).toHaveTextContent(
      '감지됨',
    );
    // detected-without-credential is a different sentence than active.
    expect(
      screen.getByText(/아직 아무 권한도 열리지 않았습니다/),
    ).toBeTruthy();
    const row = screen.getByTestId(`hosted-row-${CONNECTION_ID}`);
    expect(row.props.accessibilityLabel).toContain('감지됨');
    expect(row.props.accessibilityLabel).toContain('@kim-intern');
  });

  it('shows a permission notice, not a red error, when the list is denied', () => {
    render(
      <HostedConnectionsView
        state="denied"
        rows={[]}
        offline={false}
        onBack={noop}
        onRetry={noop}
        onOpenConnection={noop}
      />,
    );
    expect(screen.getByTestId('hosted-list-denied')).toBeTruthy();
    expect(screen.queryByTestId('hosted-list-error')).toBeNull();
  });

  it('shows an empty state when there are no connections', () => {
    render(
      <HostedConnectionsView
        state="ready"
        rows={[]}
        offline={false}
        onBack={noop}
        onRetry={noop}
        onOpenConnection={noop}
      />,
    );
    expect(screen.getByTestId('hosted-list-empty')).toBeTruthy();
  });

  it('names cached data and its timestamp when offline, distinct from active', () => {
    render(
      <HostedConnectionsView
        state="ready"
        rows={[listItem()]}
        offline
        staleAtMs={1_700_000_050_000}
        onBack={noop}
        onRetry={noop}
        onOpenConnection={noop}
      />,
    );
    const offline = screen.getByTestId('hosted-list-offline');
    expect(offline).toBeTruthy();
    expect(screen.getByText(/마지막으로 확인한 때/)).toBeTruthy();
  });
});

describe('detail — read-only status, honest time, cleanup progress', () => {
  const noop = () => {};

  function detailView(over: Record<string, unknown> = {}, artifacts: unknown[] = []) {
    return hostedDetailView(
      parseHostedConnectionDetail({
        connection: connectionWire(over),
        cleanupArtifacts: artifacts,
      }),
      '김인턴',
    );
  }

  it('shows the status chip, the detected≠active sentence, and the read-only note', () => {
    render(
      <HostedConnectionDetailView
        title="김인턴"
        state="ready"
        view={detailView({status: 'detected', activeCredentialId: undefined})}
        offline={false}
        onBack={noop}
        onRetry={noop}
      />,
    );
    expect(screen.getByTestId('hosted-detail-status-chip')).toHaveTextContent('감지됨');
    expect(screen.getByText(/사람이 채널과 권한을 확인해야/)).toBeTruthy();
    // read-only honesty: mutations live on the desktop.
    expect(screen.getByText(/데스크톱에서 합니다/)).toBeTruthy();
    // liveness honesty: updatedAtMs is not a live heartbeat.
    expect(screen.getByText(/실시간으로 알려 주는 값은 아닙니다/)).toBeTruthy();
  });

  it('counts unresolved-required cleanup items and lists the manifest read-only', () => {
    const view = detailView({status: 'cleanup_pending'}, [
      {
        id: 'connector-1',
        kind: 'connector',
        expectedAction: 'remove',
        currentStatus: 'present',
        disposition: 'pending',
        resolved: false,
        required: true,
        updatedAtMs: 5_000,
      },
      {
        id: 'secret-1',
        kind: 'secret',
        expectedAction: 'revoke',
        currentStatus: 'absent',
        disposition: 'revoked',
        resolved: true,
        required: true,
        source: 'server_verified',
        evidence: 'oort revoked 1 hosted credential(s)',
        updatedAtMs: 6_000,
      },
    ]);
    render(
      <HostedConnectionDetailView
        title="김인턴"
        state="ready"
        view={view}
        offline={false}
        onBack={noop}
        onRetry={noop}
      />,
    );
    // one required item remains (the connector); the secret is server-confirmed.
    expect(screen.getByTestId('hosted-detail-unresolved-count')).toHaveTextContent(
      '미확인 필수 1개 · 전체 2개',
    );
    expect(screen.getByTestId('hosted-artifact-connector-1')).toBeTruthy();
    expect(screen.getByTestId('hosted-artifact-chip-secret-1')).toHaveTextContent(
      '서버 확인',
    );
    // secret redaction: the English operator evidence is NEVER rendered.
    expect(screen.queryByTestId('hosted-artifact-evidence-secret-1')).toBeNull();
    expect(screen.queryByText(/revoked 1 hosted credential/)).toBeNull();
  });

  it('renders a manual acknowledgement own evidence sentence', () => {
    const view = detailView({status: 'cleanup_pending'}, [
      {
        id: 'connector-2',
        kind: 'connector',
        expectedAction: 'remove',
        currentStatus: 'absent',
        disposition: 'removed',
        resolved: true,
        required: true,
        source: 'manual',
        evidence: '커넥터 목록에서 제거를 눌렀고 사라졌습니다',
        updatedAtMs: 7_000,
      },
    ]);
    render(
      <HostedConnectionDetailView
        title="김인턴"
        state="ready"
        view={view}
        offline={false}
        onBack={noop}
        onRetry={noop}
      />,
    );
    expect(
      screen.getByTestId('hosted-artifact-evidence-connector-2'),
    ).toHaveTextContent('커넥터 목록에서 제거를 눌렀고 사라졌습니다');
    // The row is one a11y element, so the evidence must ride in its label too —
    // otherwise VoiceOver never reaches the person's own words (review H1).
    expect(
      screen.getByTestId('hosted-artifact-connector-2').props.accessibilityLabel,
    ).toContain('커넥터 목록에서 제거를 눌렀고 사라졌습니다');
  });

  it('rebuilds by named fields, so an injected secret never reaches the tree', () => {
    const view = detailView({
      status: 'active',
      pairingCredential: 'SECRET-PAIRING-VALUE',
      credential: 'SECRET-ACTIVE-VALUE',
    });
    render(
      <HostedConnectionDetailView
        title="김인턴"
        state="ready"
        view={view}
        offline={false}
        onBack={noop}
        onRetry={noop}
      />,
    );
    expect(screen.queryByText(/SECRET-PAIRING-VALUE/)).toBeNull();
    expect(screen.queryByText(/SECRET-ACTIVE-VALUE/)).toBeNull();
    expect(JSON.stringify(screen.toJSON())).not.toContain('SECRET');
  });

  it('offers a retry on error and a permission notice when denied', () => {
    const {rerender} = render(
      <HostedConnectionDetailView
        title="김인턴"
        state="error"
        offline={false}
        onBack={noop}
        onRetry={noop}
      />,
    );
    expect(screen.getByTestId('hosted-detail-error')).toBeTruthy();
    rerender(
      <HostedConnectionDetailView
        title="김인턴"
        state="denied"
        offline={false}
        onBack={noop}
        onRetry={noop}
      />,
    );
    expect(screen.getByTestId('hosted-detail-denied')).toBeTruthy();
  });
});
