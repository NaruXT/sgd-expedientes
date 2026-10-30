// Rutas de la API local. Devuelven JSON, salvo la descarga del Excel de un lote. Las
// operaciones contra el SGD se encolan y el cliente consulta el resultado por
// GET /api/trabajos/:id.
import { AppError } from '../sgd/lib/errors.ts';
import type { Config, Session } from '../sgd/lib/config.ts';
import { performLogin, detectCoDep, detectDepName } from '../sgd/auth.ts';
import { searchExpediente } from '../sgd/commands/expediente.ts';
import { runLote, LIMITE_TERMINOS } from '../sgd/commands/lote.ts';
import type { ResultadoLote } from '../sgd/commands/lote.ts';
import { requireSession } from '../sgd/runtime.ts';
import { leerExcelEntrada, MAX_BYTES_EXCEL } from '../excel/read-input.ts';
import { escribirExcelSalida } from '../excel/write-output.ts';
import type { Notifier } from '../sgd/lib/io.ts';
import { QueueFullError, toJobError } from './queue.ts';
import type { JobQueue, Job } from './queue.ts';
import type { AppState } from './state.ts';
import paquete from '../../package.json' with { type: 'json' };

export interface RouteContext {
  state: AppState;
  queue: JobQueue;
  year: () => string;
}

const MAX_TERMINOS_ENTRADA = 1000; // tope de la lista recibida; la regla de negocio (30) se aplica en runLote

const STATUS_BY_CODE: Record<string, number> = {
  usage: 400,
  not_authenticated: 401,
  session_expired: 401,
  auth_failed: 401,
  missing_codep: 409,
  network: 502,
  tls_untrusted: 502,
  server_error: 502,
  parse_error: 500,
  not_supported: 400,
};

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorJson(e: unknown): Response {
  const err = toJobError(e);
  return json({ ok: false, error: err }, e instanceof AppError ? (STATUS_BY_CODE[err.code] ?? 500) : 500);
}

async function leerJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    /* cae al error de abajo */
  }
  throw new AppError('usage', 'el cuerpo de la petición no es un objeto JSON válido');
}

function cadena(v: unknown, campo: string, max: number): string {
  if (typeof v !== 'string' || !v.trim()) throw new AppError('usage', `falta ${campo}`);
  if (v.length > max) throw new AppError('usage', `${campo} es demasiado largo`);
  return v.trim();
}

// Acepta solo URLs https sin usuario, contraseña ni ruta (el SGD vive en la raíz del host).
export function validarHost(valor: string): string {
  let url: URL;
  try {
    url = new URL(valor);
  } catch {
    throw new AppError('usage', 'la dirección del SGD no es válida; debe empezar con https://');
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.pathname !== '/' && url.pathname !== '')) {
    throw new AppError('usage', 'la dirección del SGD debe ser https://servidor[:puerto], sin ruta');
  }
  return url.origin;
}

function validarCertificado(valor: string): string {
  const pem = valor.trim();
  if (!pem.includes('-----BEGIN CERTIFICATE-----') || !pem.includes('-----END CERTIFICATE-----')) {
    throw new AppError('usage', 'el archivo del certificado no parece un certificado PEM');
  }
  if (pem.length > 100_000) throw new AppError('usage', 'el certificado es demasiado grande');
  return pem;
}

// Nombre del Excel de salida con fecha y hora local: ubicacion-expedientes-20261030-1415.xlsx
export function nombreExcel(fecha: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `ubicacion-expedientes-${fecha.getFullYear()}${p(fecha.getMonth() + 1)}${p(fecha.getDate())}-${p(fecha.getHours())}${p(fecha.getMinutes())}.xlsx`;
}

function trabajoJson(job: Job) {
  return {
    id: job.id,
    tipo: job.kind,
    estado: job.status,
    progreso: job.progress,
    notas: job.notas,
    resultado: job.status === 'listo' ? job.result : null,
    error: job.error,
  };
}

// Encola una operación que necesita sesión. La sesión se lee al ejecutar (no al encolar),
// porque un trabajo anterior puede haberla renovado.
function encolarSiSesion(
  ctx: RouteContext,
  kind: string,
  run: (session: Session, notifier: Notifier) => Promise<unknown>,
): Response {
  try {
    requireSession(ctx.state.session);
  } catch (e) {
    return errorJson(e);
  }
  try {
    const job = ctx.queue.enqueue(kind, async (notifier) => {
      try {
        return await run(requireSession(ctx.state.session), notifier);
      } catch (e) {
        if (e instanceof AppError && e.code === 'session_expired') ctx.state.cerrarSesion();
        throw e;
      }
    });
    return json({ ok: true, trabajo: job.id }, 202);
  } catch (e) {
    if (e instanceof QueueFullError) return json({ ok: false, error: { code: 'cola_llena', message: e.message } }, 429);
    return errorJson(e);
  }
}

export async function handleApi(req: Request, url: URL, ctx: RouteContext): Promise<Response> {
  const { pathname } = url;
  const method = req.method;
  const { state } = ctx;

  try {
    if (method === 'GET' && pathname === '/api/estado') {
      const cfg = state.config;
      return json({
        configurado: cfg.host !== '',
        host: cfg.host,
        tieneCertificado: Boolean(cfg.ca),
        usuario: state.session?.user ?? null,
        dependencia: cfg.coDep ? { coDep: cfg.coDep, nombre: cfg.depName ?? '' } : null,
        pendientes: ctx.queue.cantidadPendientes,
        limiteTerminos: LIMITE_TERMINOS,
        version: paquete.version,
      });
    }

    if (method === 'PUT' && pathname === '/api/configuracion') {
      const body = await leerJson(req);
      const host = validarHost(cadena(body.host, 'la dirección del SGD', 300));
      // Cambiar de servidor invalida la dependencia, la sesión y el certificado guardados:
      // cada instituto tiene su propio certificado.
      const cambioHost = host !== state.config.host;
      let ca = cambioHost ? undefined : state.config.ca;
      if (body.ca === null || body.ca === '') ca = undefined;
      else if (typeof body.ca === 'string') ca = validarCertificado(body.ca);
      else if (body.ca !== undefined) throw new AppError('usage', 'el certificado debe ser texto PEM');
      state.guardarConfig({
        host,
        ...(ca ? { ca } : {}),
        ...(cambioHost ? {} : { coDep: state.config.coDep, depName: state.config.depName }),
      });
      if (cambioHost) state.cerrarSesion();
      return json({ ok: true, host, tieneCertificado: Boolean(ca) });
    }

    if (method === 'POST' && pathname === '/api/sesion') {
      const body = await leerJson(req);
      const usuario = cadena(body.usuario, 'el usuario', 100);
      const clave = cadena(body.clave, 'la contraseña', 500);
      if (state.config.host === '') {
        throw new AppError('usage', 'primero configura la dirección del SGD');
      }
      const cfg: Config = state.config;
      const job = ctx.queue.enqueue('sesion', async (notifier) => {
        notifier.progress({ fase: 'iniciando sesión', hechos: 0, total: 1 });
        // Un intento nuevo reemplaza la sesión anterior, aunque falle.
        state.cerrarSesion();
        // La contraseña vive solo en este cierre: no entra al trabajo ni a la configuración.
        const { session, homeHtml } = await performLogin(cfg, usuario, clave);
        state.session = session;
        const coDep = detectCoDep(homeHtml);
        if (coDep) {
          state.guardarConfig({ ...state.config, coDep, depName: detectDepName(homeHtml) ?? state.config.depName });
        }
        return { usuario, dependencia: state.config.coDep ? { coDep: state.config.coDep, nombre: state.config.depName ?? '' } : null };
      });
      return json({ ok: true, trabajo: job.id }, 202);
    }

    if (method === 'DELETE' && pathname === '/api/sesion') {
      state.cerrarSesion();
      return json({ ok: true });
    }

    if (method === 'POST' && pathname === '/api/busqueda') {
      const body = await leerJson(req);
      const termino = cadena(body.termino, 'el expediente o texto a buscar', 200);
      return encolarSiSesion(ctx, 'busqueda', async (session, notifier) => {
        const outcome = await searchExpediente(termino, {
          config: state.config,
          session,
          year: ctx.year(),
          notifier,
        });
        state.session = outcome.session;
        return outcome.result;
      });
    }

    if (method === 'POST' && pathname === '/api/lote') {
      const body = await leerJson(req);
      if (!Array.isArray(body.terminos) || !body.terminos.every((t) => typeof t === 'string')) {
        throw new AppError('usage', 'la lista de expedientes debe ser un arreglo de textos');
      }
      if (body.terminos.length > MAX_TERMINOS_ENTRADA) {
        throw new AppError('usage', `la lista tiene más de ${MAX_TERMINOS_ENTRADA} filas`);
      }
      const terminos = body.terminos as string[];
      return encolarSiSesion(ctx, 'lote', async (session, notifier) => {
        const outcome = await runLote({
          config: state.config,
          session,
          year: ctx.year(),
          terminos,
          notifier,
        });
        state.session = outcome.session;
        return { resultados: outcome.resultados };
      });
    }

    // Vista previa del Excel de entrada: lee y valida, pero NO consulta el SGD. La
    // consulta empieza cuando el usuario presiona "consultar" (POST /api/lote).
    if (method === 'POST' && pathname === '/api/lote/excel') {
      const contenido = Buffer.from(await req.arrayBuffer());
      if (contenido.length > MAX_BYTES_EXCEL) {
        return json({ ok: false, error: { code: 'usage', message: 'el archivo es demasiado grande' } }, 413);
      }
      const entrada = await leerExcelEntrada(contenido);
      return json({ ok: true, ...entrada });
    }

    const trabajo = /^\/api\/trabajos\/([0-9a-f-]{36})(\/excel)?$/.exec(pathname);
    if (method === 'GET' && trabajo) {
      const job = ctx.queue.get(trabajo[1]);
      if (!job) return json({ ok: false, error: { code: 'no_encontrado', message: 'el trabajo no existe o ya expiró' } }, 404);
      if (!trabajo[2]) return json({ ok: true, trabajo: trabajoJson(job) });

      if (job.kind !== 'lote' || job.status !== 'listo') {
        throw new AppError('usage', 'el Excel solo está disponible para una consulta por lote terminada');
      }
      const { resultados } = job.result as { resultados: ResultadoLote[] };
      const excel = await escribirExcelSalida(resultados);
      return new Response(Uint8Array.from(excel), {
        headers: {
          'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'content-disposition': `attachment; filename="${nombreExcel(new Date())}"`,
          'cache-control': 'no-store',
        },
      });
    }

    return json({ ok: false, error: { code: 'no_encontrado', message: 'ruta no encontrada' } }, 404);
  } catch (e) {
    return errorJson(e);
  }
}
