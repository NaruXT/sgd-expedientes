// Búsqueda de un expediente, documento o asunto BARRIENDO las dependencias del usuario,
// y ubicación de cada coincidencia (estado, dependencia, documento). La salida son
// datos; cómo se muestran lo decide la interfaz.
import { AppError } from '../lib/errors.ts';
import type { Config, Session } from '../lib/config.ts';
import { silentNotifier } from '../lib/io.ts';
import type { Notifier } from '../lib/io.ts';
import { callConnector, buildContext } from '../runtime.ts';
import { CONNECTORS } from '../connectors.ts';
import type { Connector, ConnectorFilters } from '../connectors.ts';
import { listDependencias, activateDependencia, restoreDependencia } from './dependencia.ts';
import { collectAnexos, collectSeguimiento } from './documento.ts';
import type { AnexosData, SeguimientoNode } from './documento.ts';
import { cleanEstado, ubicarExpediente, mismaUbicacion } from './ubicacion.ts';
import type { Ubicacion } from './ubicacion.ts';

export const SEARCH_CONNECTORS = ['recepcion listar', 'emision listar'];
const MAX_EXPAND = 3; // tope de cadenas a recorrer (expedientes grandes son caros)
const MAX_SEGUI = 2; // documentos con seguimiento por búsqueda (tope de costo)

// La búsqueda debe cubrir TODOS los estados, no solo el default de cada bandeja.
// Verificado en vivo: sEstadoDoc='' devuelve todos los estados.
const ALL_STATES: ConnectorFilters = { set: { sEstadoDoc: '' } };

// Heurística: nº de expediente = sin espacios y con un corrido largo de dígitos
// (año+secuencia, p.ej. EXP-SU20250000303). Un término libre (asunto) no matchea.
// Algunos prefijos llevan un espacio interno (p.ej. "ABC DE20260000006"), así que se
// admite UN espacio siempre que el término termine en el corrido de dígitos.
export function looksLikeExpediente(term: string): boolean {
  return /^[A-Z0-9-]+( [A-Z0-9-]+)?$/i.test(term) && /\d{8,}$/.test(term);
}

function pick(row: Record<string, string>, re: RegExp): string {
  for (const [k, v] of Object.entries(row)) {
    if (k !== '_ids' && re.test(k) && v) return v;
  }
  return '';
}

function rowIds(row: Record<string, string>): { nuAnn?: string; nuEmi?: string; nuDes?: string; opcion?: string } {
  try {
    return row._ids ? (JSON.parse(row._ids) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

// Fila de un listado -> Match, si coincide con `needle` (nº de expediente, nº de
// documento o asunto). Lo comparten la búsqueda suelta y el modo lote.
export function matchFromRow(
  row: Record<string, string>,
  connectorKey: string,
  coDep: string,
  target: { nombre: string; sigla: string | null },
  needle: string,
): Match | null {
  const expediente = pick(row, /expediente/);
  const nroDocumento = pick(row, /^n_documento$|nro_documento/);
  const asunto = pick(row, /asunto/);
  if (!`${expediente} ${nroDocumento} ${asunto}`.toLowerCase().includes(needle)) return null;
  const ids = rowIds(row);
  return {
    dependencia: target.nombre,
    sigla: target.sigla,
    coDep,
    bandeja: connectorKey.split(' ')[0],
    fecha: pick(row, /f_emision|fecha/),
    nuAnn: ids.nuAnn ?? '',
    nuEmi: ids.nuEmi ?? '',
    nuDes: ids.nuDes ?? 'N',
    tipo: pick(row, /tipo_doc|^tipo$/),
    nroDocumento,
    expediente,
    asunto,
    estado: pick(row, /estado/),
    // recepción trae `remitente` (dep + persona); emisión trae `referencia_origen`
    // (la dep de origen). Ambos dicen de dónde vino el documento en ese nodo.
    origen: pick(row, /remitente|referencia_origen|referencia/),
    destinatario: pick(row, /destinatario/),
    cadena: null,
    seguimiento: null,
  };
}

// Filtro server-side de un conector para un nº de expediente: sTipoBusqueda=1 +
// campo de expediente trae el HISTÓRICO completo (el modo búsqueda ignora el
// año y el estado de la bandeja).
export function filtroPorExpediente(conn: Connector, term: string): ConnectorFilters {
  const expedienteField = conn.filterFields.expediente;
  return expedienteField ? { set: { sEstadoDoc: '', sTipoBusqueda: '1', [expedienteField]: term } } : ALL_STATES;
}

export interface Match {
  dependencia: string;
  sigla: string | null;
  coDep: string;
  bandeja: string;
  fecha: string;
  nuAnn: string;
  nuEmi: string;
  nuDes: string;
  tipo: string; // tipo de documento (PROVEIDO, INFORME, HOJA DE ENVIO, …)
  nroDocumento: string;
  expediente: string;
  asunto: string;
  estado: string;
  origen: string; // remitente (recepción) o referencia de origen (emisión): quién lo envió
  destinatario: string; // "ÁREA - PERSONA" (emisión) o solo persona (recepción)
  cadena: AnexosData | null;
  seguimiento: SeguimientoNode[] | null; // ruteo del documento con la persona asignada
}

export interface SearchResult {
  term: string;
  scope: string[]; // coDep barridos
  matches: Match[];
  expanded: number; // cuántas cadenas se recorrieron (tope MAX_EXPAND)
  ubicacion: Ubicacion | null; // A: desde tus documentos (solo en búsquedas por nº de expediente)
  ubicacionOrigen: Ubicacion | null; // B: desde el origen del expediente
  difiere: boolean; // A y B apuntan a pasos distintos: revisar a mano
  seguimiento: SeguimientoNode[] | null; // ruteo completo desde el origen (incluye el de A)
}

export interface SearchOptions {
  config: Config;
  session: Session;
  year: string;
  notifier?: Notifier;
  wantSeguimiento?: boolean; // seguimiento por documento (caro): opt-in
}

export interface SearchOutcome {
  result: SearchResult;
  // Sesión con la cookie más reciente: el barrido rota la cookie al cambiar de dependencia.
  session: Session;
}

// Barrido de búsqueda. Activa cada dependencia del usuario, consulta las bandejas y, al
// final, vuelve a la dependencia original.
export async function searchExpediente(term: string, opts: SearchOptions): Promise<SearchOutcome> {
  const { config, year, notifier = silentNotifier, wantSeguimiento = false } = opts;
  const trimmed = term.trim();
  if (!trimmed) {
    throw new AppError('usage', 'escribe un nº de expediente, nº de documento o texto del asunto');
  }
  const needle = trimmed.toLowerCase();
  const searchByExpediente = looksLikeExpediente(trimmed);

  const session0 = opts.session;
  const original = config.coDep;

  const deps = await listDependencias(config, session0);

  let sweep: Session = session0;
  const matches: Match[] = [];
  let expandedCount = 0;
  const seguidos = new Set<string>(); // nº de documentos ya seguidos (uno por doc)
  let seguimiento: SeguimientoNode[] | null = null; // ruteo completo del expediente
  let ubicacion: Ubicacion | null = null;
  let ubicacionOrigen: Ubicacion | null = null;

  notifier.note(`buscando "${trimmed}" en ${deps.length} dependencia(s)`);

  try {
    for (const [d, dep] of deps.entries()) {
      // Activar la dependencia rota la cookie: hay que propagarla al resto del barrido.
      const { cookie, target } = await activateDependencia(config, sweep, dep.coDep);
      sweep = { ...sweep, jsessionid: cookie };
      const ctx = buildContext({ ...config, coDep: dep.coDep, depName: target.nombre }, year);
      notifier.progress({ fase: 'dependencias revisadas', hechos: d + 1, total: deps.length });

      for (const key of SEARCH_CONNECTORS) {
        const conn = CONNECTORS[key];
        // Si el término es un nº de expediente y el conector sabe su campo, se busca
        // server-side para traer el histórico; si no, se barre la bandeja por defecto.
        const filter: ConnectorFilters = searchByExpediente ? filtroPorExpediente(conn, trimmed) : ALL_STATES;
        let rows: Record<string, string>[];
        try {
          rows = (await callConnector(config, sweep, conn, ctx, filter)).table.rows;
        } catch (e) {
          if (e instanceof AppError && e.code === 'session_expired') throw e;
          continue; // una bandeja puede fallar en una dependencia; seguimos
        }
        for (const row of rows) {
          const match = matchFromRow(row, key, dep.coDep, target, needle);
          if (!match) continue;
          const { nroDocumento } = match;
          const ids = rowIds(row);

          const opcion = ids.opcion ?? 'DocRecepTablaAnexoBtn';
          // Recorre la cadena aquí, con esta dependencia activa. Se limita a MAX_EXPAND.
          if (match.nuAnn && match.nuEmi && expandedCount < MAX_EXPAND) {
            try {
              match.cadena = await collectAnexos(config, sweep, match.nuAnn, match.nuEmi, match.nuDes, opcion);
              expandedCount++;
            } catch (e) {
              if (e instanceof AppError && e.code === 'session_expired') throw e;
              /* deja la coincidencia sin cadena */
            }
          }
          // Seguimiento (ruteo + persona asignada) una vez por documento distinto, opt-in
          // y capado. En búsquedas por nº de expediente no aplica: abajo se sigue entero.
          if (wantSeguimiento && !searchByExpediente && match.nuAnn && match.nuEmi && nroDocumento && !seguidos.has(nroDocumento) && seguidos.size < MAX_SEGUI) {
            seguidos.add(nroDocumento);
            try {
              match.seguimiento = await collectSeguimiento(config, sweep, match.nuAnn, match.nuEmi, match.nuDes, opcion);
            } catch (e) {
              if (e instanceof AppError && e.code === 'session_expired') throw e;
              /* deja el match sin seguimiento */
            }
          }
          matches.push(match);
        }
      }
    }

    // Ubicación actual (A y B, ver ubicacion.ts) con el detalle de TODOS los nodos.
    // Por defecto en búsquedas por nº de expediente: es la pregunta principal.
    if (searchByExpediente && matches.length > 0) {
      // Sin conteo: el seguimiento recorre un árbol de tamaño desconocido.
      notifier.progress({ fase: 'seguimiento', hechos: 0, total: 0 });
      notifier.note('siguiendo el expediente por todas las áreas para ubicarlo');
      try {
        const r = await ubicarExpediente(config, sweep, matches, 'completo');
        ({ ubicacion, ubicacionOrigen } = r);
        seguimiento = r.nodosB;
      } catch (e) {
        if (e instanceof AppError && e.code === 'session_expired') throw e;
        notifier.note('no se pudo traer el seguimiento; la ubicación queda sin dato');
      }
    }
  } finally {
    // Vuelve a la dependencia original (el barrido rotó la cookie inicial).
    if (original) {
      try {
        const cookie = await restoreDependencia(config, sweep, original);
        sweep = { ...sweep, jsessionid: cookie };
      } catch {
        notifier.note('no se pudo volver a tu dependencia original; revisa la dependencia activa');
      }
    }
  }

  const difiere = ubicacion !== null && !mismaUbicacion(ubicacion, ubicacionOrigen);
  return {
    result: { term: trimmed, scope: deps.map((d) => d.coDep), matches, expanded: expandedCount, ubicacion, ubicacionOrigen, difiere, seguimiento },
    session: sweep,
  };
}

// --- Helpers de presentación de datos (texto corto por fila) ---

// Etiqueta de un documento del expediente para el listado: "TIPO Nº".
export function matchLabel(m: Match): string {
  const nro = m.nroDocumento || `${m.nuAnn}-${m.nuEmi}`;
  return m.tipo ? `${m.tipo} ${nro}` : nro;
}

// Contexto de un documento para el listado: origen (quién lo envió) · fecha.
export function matchContexto(m: Match): string {
  return [m.origen, m.fecha].filter(Boolean).join(' · ');
}

// Estado normalizado de un documento (sin el dígito de orden "0_"), para agrupar el
// listado. Vacío cae a una etiqueta legible.
export function matchEstado(m: Match): string {
  return cleanEstado(m.estado) || '(sin estado)';
}

// Quién tiene actualmente el documento: ÁREA - PERSONA. En emisión el destinatario ya
// viene "ÁREA - PERSONA"; en recepción viene solo la persona y el área es la
// dependencia del nodo, así que se reconstruye.
export function matchActual(m: Match): string {
  const d = m.destinatario.trim();
  if (!d) return '(sin destinatario)';
  if (d.includes(' - ')) return d; // emisión: ya trae área + persona
  const area = m.sigla ?? m.dependencia; // recepción: el área es la dependencia del nodo
  return area ? `${area} - ${d}` : d;
}
