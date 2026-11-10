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
import type { Ubicacion } from './ubicacion.ts';

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

// Avance de un lote, para continuarlo si la sesión expira a mitad. El SGD expira la
// sesión a los ~30 min y, ya expirada, algunas respuestas llegan vacías en lugar de con
// la página de login: un expediente se vería como "no encontrado" sin serlo. Por eso el
// avance solo guarda trabajo verificado: cada grupo de búsqueda y cada seguimiento sin
// resultado se confirman con una consulta que exige sesión viva.
export interface AvanceLote {
  usuario: string;
  terminos: string[]; // ya normalizados
  busquedaHecha: string[]; // claves "coDep:grupo" verificadas
  matches: Record<string, Match[]>;
  seguidos: Record<string, Seguido>;
}

interface Seguido {
  ubicacion: Ubicacion | null;
  ubicacionOrigen: Ubicacion | null;
  nodos: number;
  error?: string;
}

// Expedientes por grupo de búsqueda: lo máximo que se repite si la sesión expira.
export const GRUPO_BUSQUEDA = 10;

export function nuevoAvance(usuario: string, terminos: string[]): AvanceLote {
  return { usuario, terminos: normalizarTerminos(terminos), busquedaHecha: [], matches: {}, seguidos: {} };
}

// Un avance sirve para continuar solo el mismo lote, del mismo usuario.
export function avanceAplica(avance: AvanceLote | null, usuario: string, terminos: string[]): avance is AvanceLote {
  if (!avance || avance.usuario !== usuario) return false;
  const t = normalizarTerminos(terminos);
  return t.length === avance.terminos.length && t.every((x, i) => x === avance.terminos[i]);
}

function avanceIniciado(a: AvanceLote): boolean {
  return a.busquedaHecha.length > 0 || Object.keys(a.seguidos).length > 0;
}

export interface LoteOptions {
  config: Config;
  session: Session;
  year: string;
  terminos: string[];
  detalle?: 'top' | 'completo';
  notifier?: Notifier;
  // Avance a continuar; se actualiza en el lugar. Si falta, el lote empieza de cero.
  avance?: AvanceLote;
}

export interface LoteOutcome {
  resultados: ResultadoLote[];
  // Sesión con la cookie más reciente (el lote rota la cookie al cambiar de dependencia).
  session: Session;
}

// Confirma que la sesión sigue viva: con la sesión expirada, la lista de dependencias
// llega vacía o con el login, y listDependencias lanza session_expired.
async function verificarSesion(config: Config, session: Session): Promise<void> {
  await listDependencias(config, session);
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
  const avance = opts.avance ?? nuevoAvance(opts.session.user, terminos);
  if (!avanceAplica(avance, opts.session.user, terminos)) {
    throw new Error('el avance no corresponde a este lote');
  }
  if (avanceIniciado(avance)) notifier.note('la consulta continúa desde donde quedó');

  const session0 = opts.session;
  const original = config.coDep;

  const validos = terminos.filter(looksLikeExpediente);
  const grupos: string[][] = [];
  for (let i = 0; i < validos.length; i += GRUPO_BUSQUEDA) grupos.push(validos.slice(i, i + GRUPO_BUSQUEDA));

  const deps = await listDependencias(config, session0);
  let sweep: Session = session0;
  let depActiva: string | null = null;
  let expiro = false;

  try {
    // Fase 1: una activación por dependencia; dentro, todos los expedientes, por grupos.
    // La búsqueda en emisión es la lenta del servidor, pero hace falta: una emisión del
    // usuario puede abrir una rama propia del trámite.
    for (const [d, dep] of deps.entries()) {
      const fase = deps.length > 1 ? `expedientes buscados en la dependencia ${d + 1} de ${deps.length}` : 'expedientes buscados';
      let hechos = 0;
      for (const [g, grupo] of grupos.entries()) {
        const clave = `${dep.coDep}:${g}`;
        if (avance.busquedaHecha.includes(clave)) {
          hechos += grupo.length;
          continue;
        }
        if (depActiva !== dep.coDep) {
          const { cookie } = await activateDependencia(config, sweep, dep.coDep);
          sweep = { ...sweep, jsessionid: cookie };
          depActiva = dep.coDep;
        }
        const ctx: ConnectorContext = { coDep: dep.coDep, depName: dep.nombre, year };
        const encontrados: Record<string, Match[]> = {};
        for (const term of grupo) {
          const needle = term.toLowerCase();
          const propios: Match[] = [];
          for (const key of SEARCH_CONNECTORS) {
            const conn = CONNECTORS[key];
            try {
              const rows = (await callConnector(config, sweep, conn, ctx, filtroPorExpediente(conn, term))).table.rows;
              for (const row of rows) {
                const m = matchFromRow(row, key, dep.coDep, dep, needle);
                if (m) propios.push(m);
              }
            } catch (e) {
              if (e instanceof AppError && e.code === 'session_expired') throw e;
              // una bandeja puede fallar en una dependencia; seguimos
            }
          }
          encontrados[term] = propios;
          notifier.progress({ fase, hechos: ++hechos, total: validos.length });
        }
        // Solo cuenta si la sesión siguió viva durante todo el grupo.
        await verificarSesion(config, sweep);
        for (const [term, ms] of Object.entries(encontrados)) (avance.matches[term] ??= []).push(...ms);
        avance.busquedaHecha.push(clave);
      }
    }

    // Fase 2: seguimiento de cada expediente, en secuencia y en el mismo orden de `validos`.
    let hechos = 0;
    for (const term of validos) {
      if (!avance.seguidos[term]) {
        const ms = avance.matches[term] ?? [];
        let seguido: Seguido;
        if (ms.length === 0) {
          seguido = { ubicacion: null, ubicacionOrigen: null, nodos: 0 };
        } else {
          try {
            const r = await ubicarExpediente(config, sweep, ms, detalle);
            seguido = {
              ubicacion: r.ubicacion,
              ubicacionOrigen: r.ubicacionOrigen,
              nodos: r.nodosB.length,
              ...(r.ubicacion ? {} : { error: 'seguimiento vacío (respuesta inesperada del SGD)' }),
            };
          } catch (e) {
            if (e instanceof AppError && e.code === 'session_expired') throw e;
            seguido = { ubicacion: null, ubicacionOrigen: null, nodos: 0, error: e instanceof Error ? e.message : String(e) };
          }
          // Un seguimiento sin ubicación puede deberse a una sesión expirada.
          if (!seguido.ubicacion) await verificarSesion(config, sweep);
        }
        avance.seguidos[term] = seguido;
      }
      notifier.progress({ fase: 'seguimiento de expedientes', hechos: ++hechos, total: validos.length });
    }
  } catch (e) {
    if (e instanceof AppError && e.code === 'session_expired') expiro = true;
    throw e;
  } finally {
    // Con la sesión expirada no hay a qué dependencia volver: el próximo login la fija.
    if (original && !expiro) {
      try {
        const cookie = await restoreDependencia(config, sweep, original);
        sweep = { ...sweep, jsessionid: cookie };
      } catch {
        notifier.note('no se pudo volver a tu dependencia original; revisa la dependencia activa');
      }
    }
  }

  const errores = new Map<string, string>();
  for (const t of terminos) if (!looksLikeExpediente(t)) errores.set(t, 'no parece un nº de expediente');
  const resultados: ResultadoLote[] = terminos.map((term) => {
    const s = avance.seguidos[term];
    const count = avance.matches[term]?.length ?? 0;
    const error = errores.get(term) ?? s?.error ?? (s && count === 0 ? 'sin coincidencias en tus dependencias' : undefined);
    const a = s?.ubicacion ?? null;
    const b = s?.ubicacionOrigen ?? null;
    return {
      term,
      ok: !error,
      count,
      nodos: s?.nodos ?? 0,
      ubicacion: a,
      ubicacionOrigen: b,
      difiere: mismaUbicacion(a, b) === false,
      ...(error ? { error } : {}),
    };
  });

  return { resultados, session: sweep };
}
