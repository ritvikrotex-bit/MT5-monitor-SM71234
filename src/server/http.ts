import { jsonError } from "./errors";
import { requireAdmin, requireUser, type SessionUser } from "./session";

export async function withAuth(
  request: Request,
  handler: (user: SessionUser) => Promise<Response>,
): Promise<Response> {
  try {
    const user = await requireUser(request);
    return await handler(user);
  } catch (error) {
    return jsonError(error);
  }
}

export async function withAdminAuth(
  request: Request,
  handler: (user: SessionUser) => Promise<Response>,
): Promise<Response> {
  try {
    const user = await requireAdmin(request);
    return await handler(user);
  } catch (error) {
    return jsonError(error);
  }
}

export function readJson<T>(value: unknown, fallback: T): T {
  return (value ?? fallback) as T;
}
