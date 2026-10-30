// Cliente HTTP contra un servidor HTTPS local de prueba (certificado autofirmado solo
// para localhost, en test/fixtures/tls). No se toca ningún servidor real.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from '../src/sgd/lib/http.ts';
import { AppError } from '../src/sgd/lib/errors.ts';

const TLS_DIR = join(import.meta.dir, 'fixtures', 'tls');
const CERT = readFileSync(join(TLS_DIR, 'cert.pem'), 'utf8');
const KEY = readFileSync(join(TLS_DIR, 'key.pem'), 'utf8');

// Servidor de prueba: cuenta cuántas peticiones están en curso a la vez.
function startTlsServer(delayMs = 0) {
  let active = 0;
  let maxActive = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: CERT, key: KEY },
    async fetch() {
      active++;
      maxActive = Math.max(maxActive, active);
      if (delayMs > 0) await Bun.sleep(delayMs);
      active--;
      return new Response('hola', { status: 200, headers: { 'set-cookie': 'JSESSIONID=abc123; Path=/' } });
    },
  });
  return { server, host: `https://127.0.0.1:${server.port}`, maxActive: () => maxActive };
}

describe('TLS', () => {
  test('sin certificado del instituto, rechaza con tls_untrusted', async () => {
    const { server, host } = startTlsServer();
    try {
      const err = await request({ method: 'GET', host, path: '/' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('tls_untrusted');
    } finally {
      server.stop(true);
    }
  });

  test('con la cadena del instituto en ca, responde 200 y lee cookie', async () => {
    const { server, host } = startTlsServer();
    try {
      const res = await request({ method: 'GET', host, path: '/', ca: CERT });
      expect(res.status).toBe(200);
      expect(res.body.toString('utf8')).toBe('hola');
      expect(res.setCookie[0]).toContain('JSESSIONID=abc123');
    } finally {
      server.stop(true);
    }
  });

  test('rechaza hosts que no son https', async () => {
    const err = await request({ method: 'GET', host: 'http://127.0.0.1:9', path: '/' }).catch((e: unknown) => e);
    expect((err as AppError).code).toBe('usage');
  });
});

describe('tope de requests en vuelo', () => {
  test('con 4 peticiones simultáneas, el servidor nunca ve más de 1 activa', async () => {
    const { server, host, maxActive } = startTlsServer(30);
    try {
      const results = await Promise.all(
        [1, 2, 3, 4].map(() => request({ method: 'GET', host, path: '/', ca: CERT })),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(maxActive()).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});
