export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errResponse(code: string, message: string) {
  return { error: { code, message } };
}
