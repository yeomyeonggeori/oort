import type {LoginResponse, Member} from '../lib/api';
import {SELF_ID, WS_ID} from './ids';

/** Test-only session values; applying them to storage belongs to the client. */
export function loginBody(who: Member): LoginResponse {
  return {
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
    member: who,
  } as LoginResponse;
}

export function selfMember(over: Partial<Member> = {}): Member {
  return {
    id: SELF_ID,
    workspaceId: WS_ID,
    kind: 'human',
    displayName: '이름',
    handle: 'handle',
    ...over,
  } as Member;
}
