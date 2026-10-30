// Ubicación de VARIOS expedientes en una corrida (máximo LIMITE_TERMINOS). Hace lo mismo
// que la búsqueda de un expediente para cada uno, pero reorganiza el trabajo:
//   1. Cada dependencia se activa UNA vez (no una vez por expediente) y, con ella
//      activa, se buscan todos los expedientes.
//   2. El seguimiento de cada expediente se recorre después, en secuencia, y por
//      defecto solo pide el detalle de los nodos más recientes (top).
// El tope de requests simultáneos al SGD es 1 y está fijado en http.ts: todo corre en
// secuencia.
import { AppError } from '../lib/errors.ts';
import type { Config, Session } from '../lib/config.ts';
import { silentNotifier } from '../lib/io.ts';
import type { Notifier } from '../lib/io.ts';
import { callConnector } from '../runtime.ts';
import { CONNECTORS } from '../connectors.ts';
import type { ConnectorContext } from '../connectors.ts';
import { listDependencias, activateDependencia, restoreDependencia } from './dependencia.ts';
import { SEARCH_CONNECTORS, looksLikeExpediente, matchFromRow, filtroPorExpediente } from './expediente.ts';
import type { Match } from './expediente.ts';
import { ubicarExpediente, mismaUbicacion } from './ubicacion.ts';
import type { Ubicacion, UbicacionDoble } from './ubicacion.ts';

export const LIMITE_TERMINOS = 30;

export interface ResultadoLote {
  term: string;
  ok: boolean;
  count: number; // coincidencias en tus bandejas
  nodos: number; // nodos del seguimiento recorrido
  ubicacion: Ubicacion | null; // A: desde tus documentos (verificable con la ventana Seguimiento de tu fila)
  ubicacionOrigen: Ubicacion | null; // B: desde el origen del expediente
  difiere: boolean; // A y B no coinciden en estado/dependencia/documento: revisar a mano
  error?: string;
}

// Limpia una lista de términos: sin espacios, sin vacíos ni duplicados, en orden.
export function normalizarTerminos(valores: string[]): string[] {
  return [...new Set(valores.map((v) => v.trim()).filter(Boolean))];
}

// Términos de un texto: uno por línea.
export function leerTerminos(texto: string): string[] {
  return normalizarTerminos(texto.split(/\r?\n/));
}

export interface LoteOptions {
  config: Config;
  session: Session;
  year: string;
  terminos: string[];
  detalle?: 'top' | 'completo';
  notifier?: Notifier;
}

export interface LoteOutcome {
  resultados: ResultadoLote[];
  // Sesión con la cookie más reciente (el lote rota la cookie al cambiar de dependencia).
  session: Session;
}

export async function runLote(opts: LoteOptions): Promise<LoteOutcome> {
  const { config, year, notifier = silentNotifier } = opts;
  const detalle = opts.detalle ?? 'top';

  const terminos = normalizarTerminos(opts.terminos);
  if (terminos.length === 0) {
    throw new AppError('usage', 'no hay números de expediente para consultar');
  }
  if (terminos.length > LIMITE_TERMINOS) {
    throw new AppError('usage', `el lote tiene ${terminos.length} expedientes; el máximo es ${LIMITE_TERMINOS}`, {
      hint: 'divide el archivo; para volúmenes mayores comunícate con TI',
    });
  }

  const session0 = opts.session;
  const original = config.coDep;

  const validos = terminos.filter(looksLikeExpediente);
  const matches = new Map<string, Match[]>(validos.map((t) => [t, []]));
  const errores = new Map<string, string>();
  for (const t of terminos) if (!looksLikeExpediente(t)) errores.set(t, 'no parece un nº de expediente');

  const deps = await listDependencias(config, session0);
  let sweep: Session = session0;
  const ubicaciones: UbicacionDoble[] = [];

  try {
    // Fase 1: una activación por dependencia; dentro, todos los expedientes.
    // La búsqueda en emisión es la lenta del servidor, pero hace falta: una emisión del
    // usuario puede abrir una rama propia del trámite.
    for (const [d, dep] of deps.entries()) {
      const { cookie, target } = await activateDependencia(config, sweep, dep.coDep);
      sweep = { ...sweep, jsessionid: cookie };
      const ctx: ConnectorContext = { coDep: dep.coDep, depName: target.nombre, year };
      let hechos = 0;
      for (const term of validos) {
        const needle = term.toLowerCase();
        for (const key of SEARCH_CONNECTORS) {
          const conn = CONNECTORS[key];
          try {
            const rows = (await callConnector(config, sweep, conn, ctx, filtroPorExpediente(conn, term))).table.rows;
            for (const row of rows) {
              const m = matchFromRow(row, key, dep.coDep, target, needle);
              if (m) matches.get(term)!.push(m);
            }
          } catch (e) {
            if (e instanceof AppError && e.code === 'session_expired') throw e;
            // una bandeja puede fallar en una dependencia; seguimos
          }
        }
        const fase = deps.length > 1 ? `expedientes buscados en la dependencia ${d + 1} de ${deps.length}` : 'expedientes buscados';
        notifier.progress({ fase, hechos: ++hechos, total: validos.length });
      }
    }

    // Fase 2: seguimiento de cada expediente, en secuencia y en el mismo orden de `validos`.
    let hechos = 0;
    for (const term of validos) {
      const ms = matches.get(term)!;
      try {
        if (ms.length === 0) {
          ubicaciones.push({ nodosA: [], nodosB: [], ubicacion: null, ubicacionOrigen: null });
        } else {
          const r = await ubicarExpediente(config, sweep, ms, detalle);
          if (!r.ubicacion) errores.set(term, 'seguimiento vacío (¿sesión expirada o respuesta inesperada?)');
          ubicaciones.push(r);
        }
      } catch (e) {
        if (e instanceof AppError && e.code === 'session_expired') throw e;
        errores.set(term, e instanceof Error ? e.message : String(e));
        ubicaciones.push({ nodosA: [], nodosB: [], ubicacion: null, ubicacionOrigen: null });
      }
      notifier.progress({ fase: 'seguimiento de expedientes', hechos: ++hechos, total: validos.length });
    }
  } finally {
    if (original) {
      try {
        const cookie = await restoreDependencia(config, sweep, original);
        sweep = { ...sweep, jsessionid: cookie };
      } catch {
        notifier.note('no se pudo volver a tu dependencia original; revisa la dependencia activa');
      }
    }
  }

  const porTermino = new Map(validos.map((t, i) => [t, ubicaciones[i]]));
  const resultados: ResultadoLote[] = terminos.map((term) => {
    const u = porTermino.get(term);
    const count = matches.get(term)?.length ?? 0;
    const error = errores.get(term) ?? (u && count === 0 ? 'sin coincidencias en tus dependencias' : undefined);
    const a = u?.ubicacion ?? null;
    const b = u?.ubicacionOrigen ?? null;
    return {
      term,
      ok: !error,
      count,
      nodos: u?.nodosB.length ?? 0,
      ubicacion: a,
      ubicacionOrigen: b,
      difiere: mismaUbicacion(a, b) === false,
      ...(error ? { error } : {}),
    };
  });

  return { resultados, session: sweep };
}
