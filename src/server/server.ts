// Servidor HTTP local. Solo escucha en 127.0.0.1, valida el encabezado Host (contra
// DNS rebinding) y exige un token aleatorio por ejecución en cada llamada a /api.
import { AppState } from './state.ts';
import { JobQueue } from './queue.ts';
import { handleApi, json } from './routes.ts';
import { CABECERAS_SEGURIDAD, ESTATICOS, paginaPrincipal } from './assets.ts';

const MAX_CUERPO = 1_000_000; // bytes

export interface ServerOptions {
  port: number;
  dataDir?: string; // carpeta de configuración (por defecto, la del sistema)
  year?: () => string;
}

export interface RunningServer {
  url: string;
  token: string;
  port: number;
  state: AppState;
  queue: JobQueue;
  stop(): void;
}

export function startServer(opts: ServerOptions): RunningServer {
  const token = randomToken();
  const state = new AppState(opts.dataDir);
  const queue = new JobQueue();
  const year = opts.year ?? (() => String(new Date().getFullYear()));

  async function responder(req: Request): Promise<Response> {
    const allowed = new Set([`127.0.0.1:${server.port}`, `localhost:${server.port}`]);
    if (!allowed.has(req.headers.get('host') ?? '')) {
      return new Response('Host no permitido', { status: 403 });
    }

    const url = new URL(req.url);
    if (url.pathname === '/' && req.method === 'GET') {
      return new Response(paginaPrincipal(token), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    const estatico = ESTATICOS[url.pathname];
    if (estatico && req.method === 'GET') {
      return new Response(estatico.contenido, { headers: { 'content-type': estatico.tipo } });
    }

    if (url.pathname.startsWith('/api/')) {
      if (req.headers.get('x-sgd-token') !== token) {
        return json({ ok: false, error: { code: 'no_autorizado', message: 'token inválido' } }, 401);
      }
      const largo = Number(req.headers.get('content-length') ?? 0);
      if (largo > MAX_CUERPO) return json({ ok: false, error: { code: 'usage', message: 'la petición es demasiado grande' } }, 413);
      return handleApi(req, url, { state, queue, year });
    }

    return new Response('No encontrado', { status: 404 });
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port,
    async fetch(req) {
      const res = await responder(req);
      for (const [k, v] of Object.entries(CABECERAS_SEGURIDAD)) {
        if (!res.headers.has(k)) res.headers.set(k, v);
      }
      return res;
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/`,
    token,
    port: server.port ?? opts.port,
    state,
    queue,
    stop: () => server.stop(true),
  };
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
