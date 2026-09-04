export class OabError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "OabError";
    this.code = code;
  }
}

export function asOabError(error, fallbackCode = "oab_error") {
  if (error instanceof OabError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new OabError(fallbackCode, message, { cause: error });
}
