// Login y conectores contra el SGD de prueba (test/helpers/sgd-mock.ts). Credenciales
// ficticias. No se toca ningún servidor real.
import { afterEach, describe, expect, test } from 'bun:test';
import { performLogin, looksLikeLoginPage, detectCoDep } from '../src/sgd/auth.ts';
import { callConnector, requireSession } from '../src/sgd/runtime.ts';
import { CONNECTORS } from '../src/sgd/connectors.ts';
import type { Config, Session } from '../src/sgd/lib/config.ts';
import { AppError } from '../src/sgd/lib/errors.ts';
import { CERT, HOME, LOGIN_FORM, PASS, USER, startSgdMock } from './helpers/sgd-mock.ts';
import type { SgdMock } from './helpers/sgd-mock.ts';

let sgd: SgdMock | null = null;
afterEach(() => {
  sgd?.stop();
  sgd = null;
});

const configFor = (host: string): Config => ({ host, ca: CERT, coDep: '555', depName: 'OFICINA' });
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('login', () => {
  test('con credenciales válidas, devuelve la sesión con la cookie más reciente', async () => {
    sgd = startSgdMock();
    const result = await performLogin(configFor(sgd.host), USER, PASS);
    expect(result.session.jsessionid).toBe('s2');
    expect(result.session.user).toBe(USER);
    expect(detectCoDep(result.homeHtml)).toBe('555');
  });

  test('envía el usuario en mayúsculas y ambos campos en Base64', async () => {
    sgd = startSgdMock();
    await performLogin(configFor(sgd.host), USER, PASS);
    const form = new URLSearchParams(sgd.bodyPosted());
    expect(form.get('coUsuario')).toBe(b64('ANA.PRUEBA'));
    expect(form.get('dePassword')).toBe(b64(PASS));
  });

  test('con credenciales inválidas, rechaza con auth_failed sin revelar la contraseña', async () => {
    sgd = startSgdMock();
    const err = await performLogin(configFor(sgd.host), USER, 'otra').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('auth_failed');
    expect((err as AppError).message).not.toContain('otra');
  });

  test('detecta la página de login', () => {
    expect(looksLikeLoginPage(LOGIN_FORM)).toBe(true);
    expect(looksLikeLoginPage(HOME)).toBe(false);
  });
});

describe('conectores', () => {
  const session: Session = { jsessionid: 's2', user: USER, createdAt: '2026-01-01T00:00:00Z' };
  const ctx = { coDep: '555', depName: 'OFICINA', year: '2026' };

  test('extrae la grilla del conector y devuelve filas con clave por encabezado', async () => {
    sgd = startSgdMock();
    const { table } = await callConnector(configFor(sgd.host), session, CONNECTORS['emision listar'], ctx, {});
    expect(table.rowCount).toBe(1);
    expect(table.rows[0].expediente).toBe('EXP-20260000174');
  });

  test('sin dependencia configurada, falla antes de llamar al SGD', async () => {
    sgd = startSgdMock();
    const err = await callConnector(configFor(sgd.host), session, CONNECTORS['emision listar'], { ...ctx, coDep: '' }, {}).catch((e: unknown) => e);
    expect((err as AppError).code).toBe('missing_codep');
  });

  test('una redirección del conector se interpreta como sesión expirada', async () => {
    sgd = startSgdMock({ conectorStatus: 302 });
    const err = await callConnector(configFor(sgd.host), session, CONNECTORS['recepcion listar'], ctx, {}).catch((e: unknown) => e);
    expect((err as AppError).code).toBe('session_expired');
  });

  test('requireSession exige sesión', () => {
    expect(() => requireSession(null)).toThrow(AppError);
    expect(requireSession(session)).toBe(session);
  });
});
