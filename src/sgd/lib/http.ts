// Cliente HTTP sobre node:https. Cero dependencias.
// No loguea cuerpos de petición ni respuesta: pueden contener PII de terceros.
// La verificación TLS siempre está activa. Si el instituto usa un certificado que el
// sistema no conoce, se entrega su cadena de confianza en `ca` (PEM).
import { request as httpsRequest, Agent } from 'node:https';
import { AppError } from './errors.ts';

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  setCookie: string[];
}

export interface RequestOptions {
  method: 'GET' | 'POST';
  host: string; // base, ej. https://sgd.ejemplo.gob.pe:8181
  path: string; // ej. /sgd/4.0/srDocumentoAdmRecepcion.do?accion=goInicio
  headers?: Record<string, string>;
  body?: string | Buffer;
  cookie?: string; // valor de JSESSIONID (solo el token, sin nombre)
  ca?: string; // cadena de confianza del instituto (PEM); vacío = confianza del sistema
  timeoutMs?: number;
  xhr?: boolean; // envía X-Requested-With: XMLHttpRequest (solo llamadas AJAX)
}

export function encodeForm(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

// Tope fijo de requests en vuelo al SGD (servidor viejo, GlassFish 4). No es
// configurable desde la interfaz: con 1, las llamadas se serializan.
const MAX_IN_FLIGHT = 1;
let inFlight = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next(); // el cupo pasa directo al siguiente en espera
  else inFlight--;
}

// Conexiones reutilizables (keep-alive): sin esto, cada request paga un handshake
// TLS completo. Un agente por cadena de confianza (vacía = la del sistema).
const agents = new Map<string, Agent>();

function agentFor(ca: string | undefined): Agent {
  const key = ca ?? '';
  let agent = agents.get(key);
  if (!agent) {
    agent = new Agent({ keepAlive: true, ...(ca ? { ca } : {}) });
    agents.set(key, agent);
  }
  return agent;
}

// Fallas transitorias de conexión: el servidor cerró un socket keep-alive que se iba
// a reutilizar, o se reinició. Se reintentan; todas las llamadas del programa son
// lecturas (incluso los POST de los conectores), así que repetirlas no tiene efectos.
const TRANSITORIO = /socket hang up|ECONNRESET|EPIPE|ECONNREFUSED|ETIMEDOUT/i;
const REINTENTOS = 3;

export async function request(opts: RequestOptions): Promise<HttpResponse> {
  for (let intento = 0; ; intento++) {
    await acquire();
    try {
      return await doRequest(opts);
    } catch (e) {
      const transitorio = e instanceof AppError && e.code === 'network' && TRANSITORIO.test(e.message);
      if (!transitorio || intento >= REINTENTOS) throw e;
    } finally {
      release();
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** intento)); // 0.5 s, 1 s, 2 s (sin ocupar cupo)
  }
}

function doRequest(opts: RequestOptions): Promise<HttpResponse> {
  const url = new URL(opts.path, opts.host);
  if (url.protocol !== 'https:') {
    return Promise.reject(new AppError('usage', 'el host del SGD debe usar https'));
  }
  const timeoutMs = opts.timeoutMs ?? 30000;

  const headers: Record<string, string> = {
    'User-Agent': 'sgd-expedientes/0.1',
    Accept: '*/*',
    // X-Requested-With solo en llamadas AJAX (los conectores), no en el login,
    // que en el navegador es un submit de formulario nativo sin ese header.
    ...(opts.xhr ? { 'X-Requested-With': 'XMLHttpRequest' } : {}),
    ...(opts.headers ?? {}),
  };
  if (opts.cookie) headers['Cookie'] = `JSESSIONID=${opts.cookie}`;
  if (opts.body != null) {
    const len = Buffer.byteLength(opts.body);
    headers['Content-Length'] = String(len);
    if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    }
  }

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: opts.method,
        headers,
        agent: agentFor(opts.ca),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const setCookieRaw = res.headers['set-cookie'];
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            setCookie: Array.isArray(setCookieRaw) ? setCookieRaw : setCookieRaw ? [setCookieRaw] : [],
          });
        });
      },
    );
    req.on('error', (e: NodeJS.ErrnoException) => {
      // Traduce fallas de TLS a un error accionable, sin volcar detalles internos.
      const code = e.code ?? '';
      if (
        code.includes('CERT') ||
        code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
        code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
        code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
      ) {
        reject(
          new AppError('tls_untrusted', 'el certificado del servidor no es confiable', {
            hint: 'hay que configurar el certificado del instituto en Configuración',
          }),
        );
        return;
      }
      reject(new AppError('network', `falla de red: ${e.message}`));
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new AppError('network', `timeout tras ${timeoutMs}ms`));
    });
    req.setTimeout(timeoutMs);
    if (opts.body != null) req.write(opts.body);
    req.end();
  });
}

// Extrae el token JSESSIONID de las cabeceras Set-Cookie.
export function extractJsessionid(setCookie: string[]): string | null {
  for (const c of setCookie) {
    const m = /JSESSIONID=([^;]+)/.exec(c);
    if (m) return m[1];
  }
  return null;
}
