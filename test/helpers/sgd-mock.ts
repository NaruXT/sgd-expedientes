// Servidor HTTPS de prueba que imita las rutas del SGD que usa la app: login,
// dependencias, cambio de dependencia y conectores. Credenciales ficticias.
// Nunca apunta a un servidor real.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TLS_DIR = join(import.meta.dir, '..', 'fixtures', 'tls');
export const CERT = readFileSync(join(TLS_DIR, 'cert.pem'), 'utf8');
const KEY = readFileSync(join(TLS_DIR, 'key.pem'), 'utf8');

export const USER = 'ana.prueba';
export const PASS = 'clave-ficticia';
export const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

export const LOGIN_FORM = `<html><form><input id="cousuario" name="coUsuario"><input id="depass" type="password"></form></html>`;
export const HOME = `<html><body><input name="coDep" value="555"><input name="deDependencia" value="OFICINA DE PRUEBA"><h1>Bienvenida</h1></body></html>`;
export const DEPS_HTML = `<table><tr><td>OF</td><td onclick="fu_activaDependencia('555','OFICINA DE PRUEBA')">OFICINA DE PRUEBA</td></tr></table>`;
export const TABLA = `<table><tr><th>Expediente</th><th>Estado</th></tr><tr><td>EXP-20260000174</td><td>0_NO LEIDO</td></tr></table>`;

export interface SgdMockOptions {
  conectorStatus?: number; // fuerza un status en los conectores (ej. 302 = sesión expirada)
  // Expira la sesión en silencio tras N llamadas a conectores, como el SGD real: la lista
  // de dependencias y las bandejas llegan vacías en lugar de con la página de login.
  // Un login nuevo revive la sesión y ya no vuelve a expirar.
  expiraTrasConectores?: number;
}

const DEPS_VACIA = '<table></table>';
const TABLA_VACIA = '<table><tr><th>Expediente</th><th>Estado</th></tr></table>';

export interface SgdMock {
  host: string;
  bodyPosted(): string; // último cuerpo recibido en el POST de login
  conectores(): number; // llamadas a conectores recibidas
  stop(): void;
}

export function startSgdMock(opts: SgdMockOptions = {}): SgdMock {
  let bodyPosted = '';
  let conectores = 0;
  let expirada = false;
  let yaExpiro = false;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: CERT, key: KEY },
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === '/sgd/login.do' && req.method === 'GET') {
        return new Response(LOGIN_FORM, { headers: { 'set-cookie': 'JSESSIONID=s1; Path=/' } });
      }
      if (pathname === '/sgd/login.do' && req.method === 'POST') {
        bodyPosted = await req.text();
        const form = new URLSearchParams(bodyPosted);
        const ok = form.get('coUsuario') === b64(USER.toUpperCase()) && form.get('dePassword') === b64(PASS);
        if (ok) {
          expirada = false;
          return new Response(null, { status: 302, headers: { location: '/sgd/home', 'set-cookie': 'JSESSIONID=s2; Path=/' } });
        }
        return new Response(LOGIN_FORM, { status: 200, headers: { 'set-cookie': 'JSESSIONID=s1; Path=/' } });
      }
      if (pathname === '/sgd/home') return new Response(HOME);
      if (pathname === '/sgd/4.0/cambiaDep.do') return new Response(expirada ? DEPS_VACIA : DEPS_HTML);
      if (pathname === '/sgd/acceso.do') return new Response('', { status: 200, headers: { 'set-cookie': 'JSESSIONID=s3; Path=/' } });
      if (pathname.startsWith('/sgd/4.0/srDocObjeto')) return new Response('no encontrado');
      if (pathname.startsWith('/sgd/4.0/')) {
        if (opts.conectorStatus) return new Response('', { status: opts.conectorStatus });
        conectores++;
        if (!yaExpiro && opts.expiraTrasConectores !== undefined && conectores > opts.expiraTrasConectores) {
          expirada = true;
          yaExpiro = true;
        }
        return new Response(expirada ? TABLA_VACIA : TABLA);
      }
      return new Response('no encontrado', { status: 404 });
    },
  });
  return {
    host: `https://127.0.0.1:${server.port}`,
    bodyPosted: () => bodyPosted,
    conectores: () => conectores,
    stop: () => server.stop(true),
  };
}
