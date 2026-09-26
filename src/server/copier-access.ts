import { ApiError } from "./errors";
import { getUserById } from "./user-store";

/**
 * Gate every copier route on an explicit permission.
 *
 * Unlike monitoring, the copier places real orders on a real account, so the
 * check applies to every role — an ADMIN is an oversight account and does not
 * get an implicit pass. The permission is re-read from the store rather than
 * trusted from the session, so revoking it takes effect immediately.
 */
export function requireCopierPermission(user: { id: string }): void {
  const live = getUserById(user.id);
  if (!live || live.permissions?.canUseCopier !== true) {
    throw new ApiError(
      "FORBIDDEN",
      "Trade copying is not enabled for your account. Please contact your administrator.",
      403,
    );
  }
}
