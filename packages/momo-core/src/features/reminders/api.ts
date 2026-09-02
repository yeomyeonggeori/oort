// =============================================================================
// REST client for message reminders (ADR-0175 / A-41).
//
// The server half lives on track/engine (#1905). This file is the contracted
// consumption layer: camelCase bodies, deny-unknown on the server, owner CRUD.
// Tests mock fetch. Live conformance waits for main promotion.
//
//   POST   /v1/workspaces/{ws}/reminders
//   GET    /v1/workspaces/{ws}/reminders?state=pending|all
//   PATCH  /v1/workspaces/{ws}/reminders/{id}
//   DELETE /v1/workspaces/{ws}/reminders/{id}
//
// Default GET state is pending. There is no outbox fan-out; due arrival is a
// client poll at the same 30s cadence as read-state.
// =============================================================================

import { ApiError } from "../../lib/api";
import { fetchWithDeadline } from "../../lib/http";
import { apiBase, coreSession } from "../../runtime/host";
import { responseRecord } from "../../lib/wire";
import {
  parseReminderPage,
  parseReminderResponse,
  reminderNoteForWire,
  type CreateReminderInput,
  type PatchReminderInput,
  type ReminderListState,
  type ReminderPage,
  type MessageReminder,
} from "./model";

async function reminderRequest(
  path: string,
  init: RequestInit = {}
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  const token = coreSession().getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetchWithDeadline(`${apiBase()}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = res.jsonOrNull<{ error?: { message?: string } }>();
    throw new ApiError(res.status, body?.error?.message ?? `HTTP ${res.status}`);
  }
  if (res.status === 204 || res.text === "") return {};
  return responseRecord(res.json<unknown>());
}

function collection(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/reminders`;
}

function item(workspaceId: string, reminderId: string): string {
  return `${collection(workspaceId)}/${encodeURIComponent(reminderId)}`;
}

export function listReminders(
  workspaceId: string,
  options: { state?: ReminderListState } = {}
): Promise<ReminderPage> {
  const state = options.state ?? "pending";
  const path = `${collection(workspaceId)}?state=${encodeURIComponent(state)}`;
  return reminderRequest(path).then(parseReminderPage);
}

export function createReminder(
  workspaceId: string,
  input: CreateReminderInput
): Promise<MessageReminder> {
  const body: Record<string, unknown> = {
    channelId: input.channelId,
    messageId: input.messageId,
    dueAtMs: input.dueAtMs,
  };
  const note = reminderNoteForWire(input.note);
  if (note !== undefined) body.note = note;
  return reminderRequest(collection(workspaceId), {
    method: "POST",
    body: JSON.stringify(body),
  }).then(parseReminderResponse);
}

export function patchReminder(
  workspaceId: string,
  reminderId: string,
  input: PatchReminderInput
): Promise<MessageReminder> {
  const body: Record<string, unknown> = {};
  if (input.dueAtMs !== undefined) body.dueAtMs = input.dueAtMs;
  if (input.completed === true) body.completed = true;
  return reminderRequest(item(workspaceId, reminderId), {
    method: "PATCH",
    body: JSON.stringify(body),
  }).then(parseReminderResponse);
}

export function deleteReminder(
  workspaceId: string,
  reminderId: string
): Promise<void> {
  return reminderRequest(item(workspaceId, reminderId), {
    method: "DELETE",
  }).then(() => undefined);
}
