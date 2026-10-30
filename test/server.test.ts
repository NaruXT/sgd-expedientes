// API local de punta a punta contra el SGD de prueba. Verifica las protecciones del
// servidor (Host, token) y el flujo de sesión, búsqueda y configuración.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server/server.ts';
import type { RunningServer } from '../src/server/server.ts';
import writeXlsxFile from 'write-excel-file/node';
import { readSheet } from 'read-excel-file/node';
import { CERT, PASS, USER, startSgdMock } from './helpers/sgd-mock.ts';
import type { SgdMock } from './helpers/sgd-mock.ts';

const abiertos: { server: RunningServer; mock?: SgdMock; dir: string }[] = [];

afterEach(() => {
  for (const { server, mock, dir } of abiertos.splice(0)) {
    server.stop();
    mock?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

function arrancar(conMock = false) {
  const dir = mkdtempSync(join(tmpdir(), 'sgd-exp-srv-'));
  const server = startServer({ port: 0, dataDir: dir, year: () => '2026' });
  const mock = conMock ? startSgdMock() : undefined;
  abiertos.push({ server, mock, dir });
  return { server, mock, dir };
}

async function api(s: RunningServer, method: string, path: string, body?: unknown, token = s.token) {
  const res = await fetch(`http://127.0.0.1:${s.port}${path}`, {
    method,
    headers: { 'x-sgd-token': token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

// Espera a que un trabajo llegue a un estado final.
async function trabajo(s: RunningServer, id: string) {
  for (let i = 0; i < 400; i++) {
    const r = await api(s, 'GET', `/api/trabajos/${id}`);
    const estado = r.json.trabajo.estado;
    if (estado === 'listo' || estado === 'error') return r.json.trabajo;
    await Bun.sleep(10);
  }
  throw new Error('el trabajo no terminó a tiempo');
}

describe('protecciones del servidor', () => {
  test('sin token, /api responde 401', async () => {
    const { server } = arrancar();
    const r = await api(server, 'GET', '/api/estado', undefined, 'token-falso');
    expect(r.status).toBe(401);
  });

  test('con token, el estado muestra la app sin configurar', async () => {
    const { server } = arrancar();
    const r = await api(server, 'GET', '/api/estado');
    expect(r.status).toBe(200);
    expect(r.json.configurado).toBe(false);
    expect(r.json.usuario).toBeNull();
  });

  test('un encabezado Host ajeno se rechaza con 403', async () => {
    const { server } = arrancar();
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: server.port, path: '/', headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  test('una ruta inexistente responde 404', async () => {
    const { server } = arrancar();
    const r = await api(server, 'GET', '/api/no-existe');
    expect(r.status).toBe(404);
  });
});

describe('interfaz', () => {
  test('la página lleva el token en <meta> y una CSP sin scripts inline', async () => {
    const { server } = arrancar();
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain(`<meta name="sgd-token" content="${server.token}">`);
    expect(html).not.toContain('__SGD_TOKEN__');
    expect(html).not.toMatch(/<script>(?!<\/script>)/); // ningún script inline
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('sirve los archivos de la interfaz con su tipo y sin token', async () => {
    const { server } = arrancar();
    for (const [ruta, tipo] of [
      ['/app.js', 'text/javascript'],
      ['/styles.css', 'text/css'],
      ['/favicon.svg', 'image/svg+xml'],
    ]) {
      const res = await fetch(`http://127.0.0.1:${server.port}${ruta}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain(tipo);
      expect((await res.text()).length).toBeGreaterThan(0);
    }
  });

  test('el estado informa la versión de la app', async () => {
    const { server } = arrancar();
    const r = await api(server, 'GET', '/api/estado');
    expect(r.json.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('configuración', () => {
  test('rechaza direcciones que no son https o que llevan ruta', async () => {
    const { server } = arrancar();
    expect((await api(server, 'PUT', '/api/configuracion', { host: 'http://sgd.ejemplo.gob.pe:8181' })).status).toBe(400);
    expect((await api(server, 'PUT', '/api/configuracion', { host: 'https://sgd.ejemplo.gob.pe/sgd' })).status).toBe(400);
  });

  test('rechaza un certificado que no es PEM', async () => {
    const { server } = arrancar();
    const r = await api(server, 'PUT', '/api/configuracion', { host: 'https://sgd.ejemplo.gob.pe:8181', ca: 'texto cualquiera' });
    expect(r.status).toBe(400);
  });

  test('guarda host y certificado, y no guarda contraseñas', async () => {
    const { server, dir } = arrancar();
    const r = await api(server, 'PUT', '/api/configuracion', { host: 'https://sgd.ejemplo.gob.pe:8181', ca: CERT });
    expect(r.status).toBe(200);
    expect(r.json.tieneCertificado).toBe(true);
    const archivos = readdirSync(dir);
    expect(archivos).toEqual(['config.json']);
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toContain('sgd.ejemplo.gob.pe');
  });
});

describe('sesión, búsqueda y lote contra el SGD de prueba', () => {
  test('la búsqueda exige sesión', async () => {
    const { server } = arrancar();
    const r = await api(server, 'POST', '/api/busqueda', { termino: 'EXP-20260000174' });
    expect(r.status).toBe(401);
  });

  test('login, búsqueda y cierre de sesión de punta a punta', async () => {
    const { server, mock } = arrancar(true);
    await api(server, 'PUT', '/api/configuracion', { host: mock!.host, ca: CERT });

    const login = await api(server, 'POST', '/api/sesion', { usuario: USER, clave: PASS });
    expect(login.status).toBe(202);
    const fin = await trabajo(server, login.json.trabajo);
    expect(fin.estado).toBe('listo');
    expect(fin.resultado.dependencia.coDep).toBe('555');

    const estado = await api(server, 'GET', '/api/estado');
    expect(estado.json.usuario).toBe(USER);
    expect(estado.json.dependencia.coDep).toBe('555');

    const busqueda = await api(server, 'POST', '/api/busqueda', { termino: 'EXP-20260000174' });
    expect(busqueda.status).toBe(202);
    const resultado = await trabajo(server, busqueda.json.trabajo);
    expect(resultado.estado).toBe('listo');
    expect(resultado.resultado.matches.length).toBeGreaterThan(0);

    expect((await api(server, 'DELETE', '/api/sesion')).status).toBe(200);
    expect((await api(server, 'GET', '/api/estado')).json.usuario).toBeNull();
  });

  test('credenciales incorrectas: error de autenticación sin dejar sesión ni contraseña', async () => {
    const { server, mock, dir } = arrancar(true);
    await api(server, 'PUT', '/api/configuracion', { host: mock!.host, ca: CERT });

    const login = await api(server, 'POST', '/api/sesion', { usuario: USER, clave: 'mala' });
    const fin = await trabajo(server, login.json.trabajo);
    expect(fin.estado).toBe('error');
    expect(fin.error.code).toBe('auth_failed');
    expect((await api(server, 'GET', '/api/estado')).json.usuario).toBeNull();

    // La contraseña no aparece ni en el registro del trabajo ni en la carpeta de datos.
    expect(JSON.stringify(fin)).not.toContain('mala');
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).not.toContain('mala');
  });

  test('la contraseña correcta nunca queda en el registro del trabajo', async () => {
    const { server, mock, dir } = arrancar(true);
    await api(server, 'PUT', '/api/configuracion', { host: mock!.host, ca: CERT });
    const login = await api(server, 'POST', '/api/sesion', { usuario: USER, clave: PASS });
    const fin = await trabajo(server, login.json.trabajo);
    expect(JSON.stringify(fin)).not.toContain(PASS);
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).not.toContain(PASS);
  });

  test('un lote con más de 30 expedientes se rechaza en el trabajo', async () => {
    const { server, mock } = arrancar(true);
    await api(server, 'PUT', '/api/configuracion', { host: mock!.host, ca: CERT });
    await trabajo(server, (await api(server, 'POST', '/api/sesion', { usuario: USER, clave: PASS })).json.trabajo);
    const terminos = Array.from({ length: 31 }, (_, i) => `EXP-2026${String(i).padStart(7, '0')}`);
    const lote = await api(server, 'POST', '/api/lote', { terminos });
    expect(lote.status).toBe(202);
    const fin = await trabajo(server, lote.json.trabajo);
    expect(fin.estado).toBe('error');
    expect(fin.error.code).toBe('usage');
  });
});

describe('Excel por la API', () => {
  async function subir(s: RunningServer, contenido: Buffer) {
    const res = await fetch(`http://127.0.0.1:${s.port}/api/lote/excel`, {
      method: 'POST',
      headers: { 'x-sgd-token': s.token, 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      body: Uint8Array.from(contenido),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  }

  test('la vista previa del Excel no requiere sesión ni consulta el SGD', async () => {
    const { server } = arrancar();
    const archivo = await writeXlsxFile([[{ value: 'Expediente' }], [{ value: 'EXP-20260000174' }], [{ value: 'EXP-20260000174' }]]).toBuffer();
    const r = await subir(server, archivo);
    expect(r.status).toBe(200);
    expect(r.json.terminos).toEqual(['EXP-20260000174']);
    expect(r.json.duplicados).toBe(1);
    expect(server.queue.cantidadPendientes).toBe(0);
  });

  test('un archivo inválido devuelve 400 con un mensaje claro', async () => {
    const { server } = arrancar();
    const r = await subir(server, Buffer.from('no es excel'));
    expect(r.status).toBe(400);
    expect(r.json.error.message).toContain('no es un Excel');
  });

  test('el Excel de un lote terminado se descarga con el formato A/B', async () => {
    const { server, mock } = arrancar(true);
    await api(server, 'PUT', '/api/configuracion', { host: mock!.host, ca: CERT });
    await trabajo(server, (await api(server, 'POST', '/api/sesion', { usuario: USER, clave: PASS })).json.trabajo);
    const lote = await api(server, 'POST', '/api/lote', { terminos: ['EXP-20260000174'] });
    const fin = await trabajo(server, lote.json.trabajo);
    expect(fin.estado).toBe('listo');

    const res = await fetch(`http://127.0.0.1:${server.port}/api/trabajos/${lote.json.trabajo}/excel`, {
      headers: { 'x-sgd-token': server.token },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml');
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="ubicacion-expedientes-\d{8}-\d{4}\.xlsx"/);
    const filas = await readSheet(Buffer.from(await res.arrayBuffer()));
    expect(filas[0]?.[0]).toBe('Número de expediente (SGD)');
    expect(filas[1]?.[0]).toBe('EXP-20260000174');
  });

  test('el Excel solo existe para lotes terminados', async () => {
    const { server, mock } = arrancar(true);
    await api(server, 'PUT', '/api/configuracion', { host: mock!.host, ca: CERT });
    const login = await api(server, 'POST', '/api/sesion', { usuario: USER, clave: PASS });
    await trabajo(server, login.json.trabajo);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/trabajos/${login.json.trabajo}/excel`, {
      headers: { 'x-sgd-token': server.token },
    });
    expect(res.status).toBe(400);
  });
});
