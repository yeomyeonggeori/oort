import { ApiError } from "@momo/core/lib/api";
import {
  HANDLE_TAKEN_SENTENCE,
  handleFieldError,
  handleSaveMessage,
  isValidHandle,
  normalizeHandle,
  workspaceNameSaveMessage,
} from "@momo/core/features/settings/model";

export {
  HANDLE_TAKEN_SENTENCE,
  handleFieldError,
  handleSaveMessage,
  isValidHandle,
  normalizeHandle,
  workspaceNameSaveMessage,
};

export const WORKSPACE_STALE_SENTENCE =
  "workspace has been updated; refetch and retry";

export function isHandleTaken(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.message === HANDLE_TAKEN_SENTENCE
  );
}

export function isWorkspaceStale(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.message === WORKSPACE_STALE_SENTENCE
  );
}

export function isField400(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 400;
}
