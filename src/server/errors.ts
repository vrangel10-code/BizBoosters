/**
 * Every failure the API can return, as a machine-readable code. Clients switch
 * on `code`, never on `message` — see docs/API.md.
 */
export type ErrorCode =
  | 'invalid_credentials'
  | 'account_locked'
  | 'account_inactive'
  | 'password_change_required'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'weak_password'
  | 'invitation_invalid'
  | 'invitation_expired'
  | 'invitation_already_accepted'
  | 'email_in_use'
  | 'login_id_in_use'
  | 'rate_limited'
  | 'room_archived'
  | 'version_conflict'
  | 'insufficient_tokens'
  | 'already_enrolled'
  | 'already_undone'
  | 'undo_window_expired'
  | 'card_name_in_use'
  | 'rarity_locked'
  | 'confirmation_required'
  | 'pool_empty'
  | 'item_not_owned'
  | 'item_state_conflict'
  | 'internal_error';

const STATUS: Record<ErrorCode, number> = {
  invalid_credentials: 401,
  account_locked: 423,
  account_inactive: 403,
  password_change_required: 403,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  weak_password: 422,
  invitation_invalid: 404,
  invitation_expired: 410,
  invitation_already_accepted: 409,
  email_in_use: 409,
  login_id_in_use: 409,
  rate_limited: 429,
  room_archived: 409,
  version_conflict: 409,
  insufficient_tokens: 409,
  already_enrolled: 409,
  already_undone: 409,
  undo_window_expired: 409,
  card_name_in_use: 409,
  rarity_locked: 409,
  confirmation_required: 422,
  pool_empty: 409,
  item_not_owned: 404,
  item_state_conflict: 409,
  internal_error: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export const apiError = (
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
) => new ApiError(code, message, details);
