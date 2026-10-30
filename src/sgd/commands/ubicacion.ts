// Dónde está un expediente: la lógica que comparten `expediente <nº>` (uno a uno) y
// `expediente lote` (masivo). Dos lecturas:
//   A (ubicacion): seguimiento desde los documentos de TUS bandejas, igual a la ventana
//     "Seguimiento del documento" del SGD al seleccionar tu fila (verificable a mano).
//   B (ubicacionOrigen): desde el ORIGEN del expediente, subiendo por las referencias
//     mientras haya un solo antecedente; ve ramas que no pasan por tus dependencias.
// En ambas se excluyen las ramas de COPIA y el paso actual es el más reciente.
import type { Config, Session } from '../lib/config.ts';
import { walkTreeConcurrente, seguimientoNodeLigero, fetchSeguimientoNode, marcarCopias, esCopia } from './documento.ts';
import type { SeguimientoNode } from './documento.ts';
import type { Match } from './expediente.ts';

const TOP_NUEMI = 5; // nº de documentos más recientes (por nuEmi) a los que se pide detalle en modo 'top'

// El SGD antepone un dígito de orden al estado en algunas grillas ("0_NO LEIDO").
export function cleanEstado(s: string): string {
  return s.replace(/^\d+_/, '').trim();
}

// dd/mm/yyyy -> comparable; vacío al final.
export function fechaKey(f: string | null | undefined): number {
  const m = f ? /(\d{2})\/(\d{2})\/(\d{4})/.exec(f) : null;
  return m ? Number(`${m[3]}${m[2]}${m[1]}`) : 0;
}

// Dónde está el expediente HOY: el nodo más reciente del seguimiento completo (lo
// mismo que la hoja que la ventana "Seguimiento del documento" del SGD resalta).
export interface Ubicacion {
  dependencia: string; // dependencia destino del último paso (ej. TESORERIA)
  receptor: string; // persona que lo tiene
  estado: string; // estado en esa dependencia (ej. ARCHIVADO)
  asunto: string; // asunto del último documento
  documento: string; // "TIPO NUMERO" del último documento
  fecha: string | null; // fecha de recepción (o de emisión si aún no se recibe)
}

export interface RaizSeguimiento {
  nuAnn: string;
  nuEmi: string;
  nuDes: string;
  opcion: string;
}

// Raíces del seguimiento completo: los documentos de las COINCIDENCIAS, los únicos
// que el SGD confirma que pertenecen al expediente (los devolvió la búsqueda por su
// nº). NO se usa la cadena de anexos: es un árbol de REFERENCIAS y puede traer
// documentos citados de OTRO expediente (ej. un informe de una baja de bienes citado
// en un requerimiento); tomar el más antiguo de ahí sigue el trámite equivocado.
// Una por documento, en orden de emisión (nuEmi = correlativo global), prefiriendo
// la fila de recepción (nuDes del destino) sobre la de emisión (nuDes='N').
export function raicesDelExpediente(matches: Match[]): RaizSeguimiento[] {
  const opcion = 'DocRecepTablaAnexoBtn';
  const porDoc = new Map<string, Match>();
  for (const m of matches) {
    if (!m.nuAnn || !m.nuEmi) continue;
    const k = `${m.nuAnn}-${m.nuEmi}`;
    const prev = porDoc.get(k);
    if (!prev || (prev.nuDes === 'N' && m.nuDes !== 'N')) porDoc.set(k, m);
  }
  return [...porDoc.values()]
    .sort((a, b) => Number(a.nuEmi) - Number(b.nuEmi))
    .map((m) => ({ nuAnn: m.nuAnn, nuEmi: m.nuEmi, nuDes: m.nuDes || 'N', opcion }));
}

// Une los árboles de seguimiento de varias raíces: se recorren en orden y se salta
// una raíz si su documento ya apareció en un árbol anterior (su rama ya está
// incluida). Los nodos se deduplican por documento + destino (nuDes).
export async function seguimientoDelExpediente(
  raices: RaizSeguimiento[],
  collect: (r: RaizSeguimiento) => Promise<SeguimientoNode[]>,
): Promise<SeguimientoNode[]> {
  const out: SeguimientoNode[] = [];
  const nodos = new Set<string>();
  const docs = new Set<string>();
  for (const r of raices) {
    if (docs.has(`${r.nuAnn}-${r.nuEmi}`)) continue;
    docs.add(`${r.nuAnn}-${r.nuEmi}`);
    for (const n of await collect(r)) {
      docs.add(`${n.nuAnn}-${n.nuEmi}`);
      const k = `${n.nuAnn}-${n.nuEmi}-${n.nuDes}`;
      if (nodos.has(k)) continue;
      nodos.add(k);
      out.push(n);
    }
  }
  return out;
}

export function ubicacionDe(nodos: SeguimientoNode[]): Ubicacion | null {
  const n = docActualNode(nodos);
  if (!n) return null;
  return {
    dependencia: n.destino,
    receptor: n.receptor,
    estado: cleanEstado(n.estado),
    asunto: n.asunto,
    documento: n.doc,
    fecha: n.fecha ?? n.fechaEmision,
  };
}

// Nodo ACTUAL del ruteo (fuera de las ramas de COPIA): el hop más reciente por FECHA,
// donde el documento está parado hoy. El árbol de ruteo se ramifica, así que NO sirve
// el último en DFS -es posicional, no cronológico-; se ordena por fecha de recepción
// (o de emisión, si el destino aún no lo recibió: si no, un envío pendiente nunca
// sería el actual) y, a igual fecha, por profundidad y orden de aparición (= el más
// avanzado en la cadena).
export function docActualNode(nodos: SeguimientoNode[]): SeguimientoNode | null {
  // Las ramas de COPIA son informativas: el trámite está en las demás. Si todo
  // fuera copia (no debería), se cae al árbol completo antes que no ubicar.
  const principales = nodos.filter((n) => !n.enCopia);
  const pool = principales.length > 0 ? principales : nodos;
  if (pool.length === 0) return null;
  return pool
    .map((n, i) => ({ n, i }))
    .sort((a, b) => fechaKey(b.n.fecha ?? b.n.fechaEmision) - fechaKey(a.n.fecha ?? a.n.fechaEmision) || b.n.nivel - a.n.nivel || b.i - a.i)[0].n;
}

// Candidatos a nodo ACTUAL sin pedir el detalle de todo el árbol: los nodos de los
// TOP_NUEMI documentos más recientes (nuEmi = correlativo global de emisión). Entre
// ellos se elige después con docActualNode (fecha), igual que en el modo completo.
export function candidatosRecientes(nodos: SeguimientoNode[], top = TOP_NUEMI): SeguimientoNode[] {
  const emis = [...new Set(nodos.map((n) => `${n.nuAnn}${n.nuEmi}`))].sort().reverse().slice(0, top);
  const keep = new Set(emis);
  return nodos.filter((n) => keep.has(`${n.nuAnn}${n.nuEmi}`));
}

// Origen del expediente según el árbol de REFERENCIAS de un documento (orden DFS, nivel
// 0 = el documento; sus hijos = los documentos que cita). Se sube mientras el documento
// cite exactamente UN antecedente: una cadena lineal es el mismo trámite. Se para en
// el que cita varios (suele ser el que ABRE un trámite citando antecedentes de otros
// expedientes, caso verificado en vivo) o ninguno (el origen real).
export function origenPorReferencias(ref: { depth: number; key: string }[]): string | null {
  if (ref.length === 0) return null;
  let i = 0;
  for (;;) {
    const hijos: number[] = [];
    for (let j = i + 1; j < ref.length && ref[j].depth > ref[i].depth; j++) {
      if (ref[j].depth === ref[i].depth + 1) hijos.push(j);
    }
    if (hijos.length !== 1) return ref[i].key;
    i = hijos[0];
  }
}

// A y B coinciden si apuntan al mismo paso (estado, dependencia y documento).
export function mismaUbicacion(a: Ubicacion | null, b: Ubicacion | null): boolean {
  if (!a || !b) return a === b;
  return a.estado === b.estado && a.dependencia === b.dependencia && a.documento === b.documento;
}

export interface UbicacionDoble {
  nodosA: SeguimientoNode[]; // seguimiento desde tus documentos
  nodosB: SeguimientoNode[]; // seguimiento desde el origen (incluye a A)
  ubicacion: Ubicacion | null; // A: desde los documentos de tus bandejas (= ventana Seguimiento de tu fila)
  ubicacionOrigen: Ubicacion | null; // B: desde el origen del expediente (todas las ramas)
}

// Ubicación A y B de UN expediente. Modo 'completo': detalle de TODOS los nodos. Modo
// 'top': recorre los árboles sin detalle y pide el detalle solo de (a) los nodos de
// documentos con VARIOS destinos -donde aparecen las COPIAS, para excluir esas ramas- y
// (b) los candidatos más recientes fuera de las copias. Cada árbol se recorre UNA vez
// aunque lo usen A y B.
export async function ubicarExpediente(
  config: Config,
  session: Session,
  matches: Match[],
  detalle: 'top' | 'completo',
): Promise<UbicacionDoble> {
  const raicesA = raicesDelExpediente(matches);
  const opcion = raicesA[0]?.opcion ?? 'DocRecepTablaAnexoBtn';
  const pk = (r: { nuAnn: string; nuEmi: string; nuDes: string }) => `${r.nuAnn}${r.nuEmi}${r.nuDes}`;
  const conDetalle = (n: SeguimientoNode): Promise<SeguimientoNode> =>
    fetchSeguimientoNode(config, session, { depth: n.nivel, key: pk(n), title: `${n.doc} -> ${n.destino}` }, opcion);

  const arboles = new Map<string, Promise<SeguimientoNode[]>>();
  const arbol = (r: RaizSeguimiento): Promise<SeguimientoNode[]> => {
    let p = arboles.get(pk(r));
    if (!p) {
      p = (async () => {
        const raw = await walkTreeConcurrente(config, session, pk(r), r.opcion, 'goDocSeguimientoRoot', 'goDocSeguimientoJson');
        const ligeros = raw.map(seguimientoNodeLigero);
        if (detalle === 'completo') return marcarCopias(await Promise.all(ligeros.map(conDetalle)));
        const destinos = new Map<string, number>();
        for (const n of ligeros) destinos.set(`${n.nuAnn}${n.nuEmi}`, (destinos.get(`${n.nuAnn}${n.nuEmi}`) ?? 0) + 1);
        const conMulti = await Promise.all(ligeros.map((n) => ((destinos.get(`${n.nuAnn}${n.nuEmi}`) ?? 0) > 1 ? conDetalle(n) : n)));
        return marcarCopias(conMulti); // marca por árbol: el orden DFS define los subárboles
      })();
      arboles.set(pk(r), p);
    }
    return p;
  };
  const elegir = async (nodos: SeguimientoNode[]): Promise<Ubicacion | null> => {
    if (detalle === 'completo') return ubicacionDe(nodos);
    const candidatos = await Promise.all(
      candidatosRecientes(nodos.filter((n) => !n.enCopia)).map(async (n) => {
        const d = n.tramite ? n : await conDetalle(n); // los de varios destinos ya traen detalle
        return { ...d, enCopia: n.enCopia || esCopia(d.tramite) };
      }),
    );
    return ubicacionDe(candidatos);
  };

  // B: origen de cada raíz por su árbol de referencias (solo estructura, sin detalle).
  const origenes = await Promise.all(
    raicesA.map(async (r) => origenPorReferencias(await walkTreeConcurrente(config, session, pk(r), r.opcion, 'goDocAnexoRoot', 'goDocAnexoJson'))),
  );
  const porPk = new Map<string, RaizSeguimiento>(raicesA.map((r) => [pk(r), r]));
  for (const k of origenes) {
    if (k && ![...porPk.values()].some((r) => `${r.nuAnn}${r.nuEmi}` === k.slice(0, 14))) {
      porPk.set(k, { nuAnn: k.slice(0, 4), nuEmi: k.slice(4, 14), nuDes: k.slice(14), opcion });
    }
  }
  const raicesB = [...porPk.values()].sort((a, b) => `${a.nuAnn}${a.nuEmi}`.localeCompare(`${b.nuAnn}${b.nuEmi}`));

  const nodosA = await seguimientoDelExpediente(raicesA, arbol);
  const nodosB = await seguimientoDelExpediente(raicesB, arbol);
  const [ubicacion, ubicacionOrigen] = await Promise.all([elegir(nodosA), elegir(nodosB)]);
  return { nodosA, nodosB, ubicacion, ubicacionOrigen };
}
