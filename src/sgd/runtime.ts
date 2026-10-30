// Runtime compartido por los comandos: ejecuta un conector y traduce la respuesta a
// filas. La configuración y la sesión llegan como parámetros: este módulo no lee disco.
import { request, encodeForm } from './lib/http.ts';
import { AppError } from './lib/errors.ts';
import type { Config, Session } from './lib/config.ts';
import { looksLikeLoginPage } from './auth.ts';
import { extractTable } from './lib/html-table.ts';
import type { ExtractedTable } from './lib/html-table.ts';
import { buildBody } from './connectors.ts';
import type { Connector, ConnectorFilters, ConnectorContext } from './connectors.ts';

// Sesión obligatoria para una operación. Sin sesión, pide iniciar sesión de nuevo.
export function requireSession(session: Session | null): Session {
  if (!session) {
    throw new AppError('not_authenticated', 'no hay sesión activa', {
      hint: 'inicia sesión con tu usuario y contraseña del SGD',
    });
  }
  return session;
}

export function buildContext(config: Config, year: string): ConnectorContext {
  return {
    coDep: config.coDep ?? '',
    depName: config.depName ?? '',
    year,
  };
}

export interface ConnectorCallResult {
  table: ExtractedTable;
  bytes: number;
}

export async function callConnector(
  config: Config,
  session: Session,
  conn: Connector,
  ctx: ConnectorContext,
  filters: ConnectorFilters,
): Promise<ConnectorCallResult> {
  if (conn.needsCoDep && !ctx.coDep) {
    throw new AppError('missing_codep', `la consulta ${conn.key} requiere la dependencia activa y no está configurada`, {
      hint: 'elige tu dependencia en la configuración y vuelve a intentar',
    });
  }

  const body = encodeForm(buildBody(conn, ctx, filters));
  const res = await request({
    method: 'POST',
    host: config.host,
    path: `/sgd/4.0/${conn.endpoint}?accion=goInicio`,
    cookie: session.jsessionid,
    body,
    ca: config.ca,
    xhr: true,
  });

  const html = res.body.toString('utf8');
  if (res.status >= 500) {
    throw new AppError('server_error', `el servidor respondió ${res.status}`);
  }
  if (looksLikeLoginPage(html) || res.status === 401 || res.status === 302) {
    throw new AppError('session_expired', 'la sesión del SGD expiró', {
      hint: 'vuelve a iniciar sesión para continuar',
    });
  }

  const table = extractTable(html);
  return { table, bytes: res.body.length };
}
