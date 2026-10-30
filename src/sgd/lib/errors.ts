// Errores estructurados y códigos de salida con significado.
// Convención de exit codes (un agente distingue error de usuario vs falla de sistema):
//   0  éxito
//   2  error de uso / configuración (args malos, no logueado, falta coDep)
//   3  error de autenticación (login rechazado, sesión expirada)
//   4  falla de sistema / red (conexión, TLS, 5xx del servidor)
//   5  error de parseo (no se pudo extraer la grilla del HTML)

export type ErrorCode =
  | 'usage'
  | 'not_authenticated'
  | 'missing_codep'
  | 'auth_failed'
  | 'session_expired'
  | 'captcha_required'
  | 'network'
  | 'tls_untrusted'
  | 'server_error'
  | 'parse_error'
  | 'not_supported';

const EXIT_BY_CODE: Record<ErrorCode, number> = {
  usage: 2,
  not_authenticated: 2,
  missing_codep: 2,
  auth_failed: 3,
  session_expired: 3,
  captcha_required: 3,
  network: 4,
  tls_untrusted: 4,
  server_error: 4,
  parse_error: 5,
  not_supported: 2,
};

export class AppError extends Error {
  code: ErrorCode;
  exit: number;
  hint?: string;
  nextSteps?: string[];

  constructor(code: ErrorCode, message: string, opts?: { hint?: string; nextSteps?: string[] }) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.exit = EXIT_BY_CODE[code];
    this.hint = opts?.hint;
    this.nextSteps = opts?.nextSteps;
  }
}

// Envelope de error para modo JSON. Nunca incluye cuerpos de respuesta (PII).
export function errorEnvelope(err: unknown): {
  ok: false;
  error: { code: string; message: string; hint?: string };
  nextSteps?: string[];
} {
  if (err instanceof AppError) {
    return {
      ok: false,
      error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) },
      ...(err.nextSteps ? { nextSteps: err.nextSteps } : {}),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'network', message } };
}
