export type ApiErrorBody = {
  error: string;
  message: string;
};

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }

  toJSON(): ApiErrorBody {
    return { error: this.code, message: this.message };
  }
}

export function jsonError(error: unknown): Response {
  if (error instanceof ApiError) {
    return Response.json(error.toJSON(), { status: error.status });
  }
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  return Response.json({ error: "INTERNAL_ERROR", message }, { status: 500 });
}

export function jsonOk(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}
