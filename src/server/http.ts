import { jsonError } from "./errors";
import { requireUser } from "./session";

export async function withAuth(
  request: Request,
  handler: (user: { id: string; email: string; name: string }) => Promise<Response>,
): Promise<Response> {
  try {
    const user = await requireUser(request);
    return await handler(user);
  } catch (error) {
    return jsonError(error);
  }
}

export function readJson<T>(value: unknown, fallback: T): T {
  return (value ?? fallback) as T;
}
