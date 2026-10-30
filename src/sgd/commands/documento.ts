// Árboles de documentos (anexos y seguimiento) y detalle de cada nodo. Solo lectura.
// No descarga archivos ni escribe en disco: la app no necesita el contenido de los
// documentos para ubicar expedientes.
import { request, encodeForm } from '../lib/http.ts';
import { AppError } from '../lib/errors.ts';
import { looksLikeLoginPage } from '../auth.ts';
import type { Config, Session } from '../lib/config.ts';

// --- Operaciones srDocObjeto (árboles y detalles) ---
// Mecanismo (verificado en vivo, de docObjetos.js):
//   árbol:     POST srDocObjeto.do?accion=goDocAnexo   pkEmi=<nuAnn><nuEmi><nuDes>
//   detalle:   POST srDocObjeto.do?accion=goDetalleDocAnexo  pkEmi=<pkEmi-nodo>
async function postDocObjeto(
  config: Config,
  session: Session,
  accion: string,
  fields: Record<string, string>,
): Promise<string> {
  const res = await request({
    method: 'POST',
    host: config.host,
    path: `/sgd/4.0/srDocObjeto.do?accion=${accion}`,
    cookie: session.jsessionid,
    body: encodeForm({ accion, ...fields }),
    ca: config.ca,
    xhr: true,
  });
  // srDocObjeto mezcla encodings por acción: el árbol/detalle de anexos responde en
  // ISO-8859-1, pero el detalle de seguimiento en UTF-8. Se decodifica UTF-8 y, si
  // aparece el carácter de reemplazo (byte latin1 inválido como UTF-8), se recae a
  // latin1. Así ambos salen sin mojibake (ej. "DIRECCIÓN" y "N°").
  const utf8 = res.body.toString('utf8');
  const text = utf8.includes('�') ? res.body.toString('latin1') : utf8;
  if (looksLikeLoginPage(text) || res.status === 302 || res.status === 401) {
    throw new AppError('session_expired', 'la sesión del SGD expiró', {
      hint: 'vuelve a iniciar sesión para continuar',
    });
  }
  return text;
}

function cellText(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

interface AnexoItem {
  nuAnn: string;
  nuEmi: string;
  nuAne: string;
  descripcion: string;
}

// Extrae los anexos descargables de una respuesta de detalle de nodo.
function parseAnexos(detalleHtml: string): AnexoItem[] {
  const out: AnexoItem[] = [];
  const rows = detalleHtml.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  for (const tr of rows) {
    // Los args pueden venir con comillas o &quot;: se normalizan antes de matchear.
    const clean = tr.replace(/&quot;/g, '"');
    const m = /fn_verDocAnexo\(\s*['"]?(\d+)['"]?\s*,\s*['"]?(\d+)['"]?\s*,\s*['"]?(\d+)/.exec(clean);
    if (!m) continue;
    const cells = (tr.match(/<td[\s\S]*?<\/td>/gi) ?? []).map(cellText).filter((c) => c.length > 0);
    out.push({ nuAnn: m[1], nuEmi: m[2], nuAne: m[3], descripcion: cells[0] ?? '' });
  }
  return out;
}

// Un nodo del árbol (dynatree). key = pkEmi = nuAnn(4)+nuEmi(10)+nuDes.
interface TreeNode {
  title?: string;
  key?: string;
  isFolder?: boolean;
  isLazy?: boolean;
  children?: TreeNode[];
}

function decodePkEmi(key: string): { nuAnn: string; nuEmi: string; nuDes: string } {
  return { nuAnn: key.slice(0, 4), nuEmi: key.slice(4, 14), nuDes: key.slice(14) };
}

// Recorre TODO un árbol (anexos o seguimiento, según rootAccion/childAccion). La
// respuesta del servidor viene parcialmente expandida (children inline) y con nodos
// isLazy cuyos hijos se cargan con childAccion (goDocAnexoJson o goDocSeguimientoJson).
// Se recurre hasta el fondo, con guarda contra ciclos y un tope de nodos.
async function walkTree(
  config: Config,
  session: Session,
  rootPkEmi: string,
  opcion: string,
  rootAccion: string,
  childAccion: string,
): Promise<{ depth: number; key: string; title: string }[]> {
  const out: { depth: number; key: string; title: string }[] = [];
  const visited = new Set<string>();
  const MAX = 300;

  async function children(node: TreeNode): Promise<TreeNode[]> {
    if (node.children && node.children.length > 0) return node.children;
    if (node.isLazy && node.key) {
      const raw = await postDocObjeto(config, session, childAccion, { pkEmi: node.key, opcion });
      try {
        return JSON.parse(raw) as TreeNode[];
      } catch {
        return [];
      }
    }
    return [];
  }

  async function visit(node: TreeNode, depth: number): Promise<void> {
    if (out.length >= MAX || !node.key || visited.has(node.key)) return;
    visited.add(node.key);
    out.push({ depth, key: node.key, title: (node.title ?? '').trim() });
    for (const c of await children(node)) await visit(c, depth + 1);
  }

  const rootRaw = await postDocObjeto(config, session, rootAccion, { pkEmi: rootPkEmi, opcion });
  let roots: TreeNode[];
  try {
    roots = JSON.parse(rootRaw) as TreeNode[];
  } catch {
    return out; // sin árbol (documento hoja o formato inesperado)
  }
  for (const r of roots) await visit(r, 0);
  return out;
}

// Igual que walkTree pero expande los hijos lazy en paralelo (el tope real de
// requests simultáneos lo pone el límite global de http.ts). Devuelve el mismo orden
// DFS que walkTree, para que `nivel` y el orden de aparición no cambien.
export async function walkTreeConcurrente(
  config: Config,
  session: Session,
  rootPkEmi: string,
  opcion: string,
  rootAccion: string,
  childAccion: string,
): Promise<{ depth: number; key: string; title: string }[]> {
  interface Expanded { depth: number; key: string; title: string; kids: Expanded[] }
  const visited = new Set<string>();
  const MAX = 300;

  async function expand(node: TreeNode, depth: number): Promise<Expanded | null> {
    if (visited.size >= MAX || !node.key || visited.has(node.key)) return null;
    visited.add(node.key); // antes de esperar: guarda contra ciclos entre ramas paralelas
    let children = node.children ?? [];
    if (children.length === 0 && node.isLazy) {
      const raw = await postDocObjeto(config, session, childAccion, { pkEmi: node.key, opcion });
      try {
        children = JSON.parse(raw) as TreeNode[];
      } catch {
        children = [];
      }
    }
    const kids = (await Promise.all(children.map((c) => expand(c, depth + 1)))).filter((k): k is Expanded => k !== null);
    return { depth, key: node.key, title: (node.title ?? '').trim(), kids };
  }

  const rootRaw = await postDocObjeto(config, session, rootAccion, { pkEmi: rootPkEmi, opcion });
  let roots: TreeNode[];
  try {
    roots = JSON.parse(rootRaw) as TreeNode[];
  } catch {
    return [];
  }
  const out: { depth: number; key: string; title: string }[] = [];
  const flatten = (e: Expanded): void => {
    out.push({ depth: e.depth, key: e.key, title: e.title });
    e.kids.forEach(flatten);
  };
  for (const r of await Promise.all(roots.map((r) => expand(r, 0)))) if (r) flatten(r);
  return out;
}

// Árbol de referencias (anexos): goDocAnexoRoot + goDocAnexoJson (lazy).
function walkAnexoTree(config: Config, session: Session, rootPkEmi: string, opcion: string) {
  return walkTree(config, session, rootPkEmi, opcion, 'goDocAnexoRoot', 'goDocAnexoJson');
}

export interface AnexoDoc {
  nivel: number;
  nuAnn: string;
  nuEmi: string;
  nuDes: string;
  titulo: string;
  fecha: string | null; // fecha de emisión del documento (dd/mm/yyyy), del detalle
  emisor: string; // quién lo originó: "DEPENDENCIA - PERSONA" (campo Emite del detalle)
  destino: string; // a quién se dirigió: "DEPENDENCIA - PERSONA" (campo Destino del detalle)
  anexos: { nuAne: string; descripcion: string }[];
}

// El detalle del anexo trae "Fecha Emi.: dd/mm/yyyy hh:mm". Se extrae solo la
// fecha (sin hora). Sirve para la trazabilidad: cada documento del árbol, incluso
// de áreas ajenas al usuario, queda fechado sin requests extra.
function parseFechaDetalle(detalleHtml: string): string | null {
  const m = /(\d{2}\/\d{2}\/\d{4})/.exec(detalleHtml);
  return m ? m[1] : null;
}

export interface AnexosData {
  raiz: { nuAnn: string; nuEmi: string; nuDes: string };
  totalDocumentos: number;
  totalAnexos: number;
  documentos: AnexoDoc[];
}

// Recorre TODO el árbol del expediente y resuelve los anexos de cada documento.
export async function collectAnexos(
  config: Config,
  session: Session,
  nuAnn: string,
  nuEmi: string,
  nuDes: string,
  opcion: string,
): Promise<AnexosData> {
  // 1. Recorre todo el árbol del expediente -> cada documento (todos los niveles).
  const nodes = await walkAnexoTree(config, session, `${nuAnn}${nuEmi}${nuDes}`, opcion);

  // 2. Para cada documento del árbol, sus anexos descargables. El detalle es un
  //    request por nodo, así que se resuelve con un pool acotado.
  const documentos: AnexoDoc[] = await mapPool(nodes, 8, async (n) => {
    const ids = decodePkEmi(n.key);
    const det = await postDocObjeto(config, session, 'goDetalleDocAnexo', { pkEmi: n.key, opcion });
    const anexos = parseAnexos(det).map((a) => ({ nuAne: a.nuAne, descripcion: a.descripcion }));
    // "Emite"/"Destino" = origen y destino del documento (dependencia + persona).
    // Ya están en el mismo HTML del detalle: cero requests extra para el hop del doc.
    const emisor = inputValueById(det, 'txtLocalEmisor').value;
    const destino = inputValueById(det, 'txtDependencia').value;
    return { nivel: n.depth, nuAnn: ids.nuAnn, nuEmi: ids.nuEmi, nuDes: ids.nuDes, titulo: n.title, fecha: parseFechaDetalle(det), emisor, destino, anexos };
  });
  const totalAnexos = documentos.reduce((s, d) => s + d.anexos.length, 0);

  return { raiz: { nuAnn, nuEmi, nuDes }, totalDocumentos: documentos.length, totalAnexos, documentos };
}

export interface SeguimientoNode {
  nivel: number;
  nuAnn: string; // ids del documento en ese paso (pkEmi decodificado)
  nuEmi: string;
  nuDes: string; // destino: el mismo documento a 2 destinos = 2 nodos
  doc: string; // "TIPO NUMERO" del documento en ese paso
  destino: string; // dependencia destino (después de "->")
  receptor: string; // persona asignada (receptor en el destino)
  fecha: string | null; // fecha de recepción en el destino (dd/mm/yyyy)
  fechaEmision: string | null; // fecha de emisión del documento (dd/mm/yyyy); vale aunque aún no se reciba
  estado: string; // estado en el destino
  asunto: string; // asunto del documento en ese paso
  tramite: string; // "ORIGINAL", "ATENDER", "COPIA", "PARA CONOCIMIENTO Y FINES"… ('' si no se pidió el detalle)
  enCopia: boolean; // el paso es una COPIA o cuelga de una: rama informativa, no lleva el trámite
}

// Una COPIA es un destino informativo: el trámite sigue por el destino ORIGINAL.
export function esCopia(tramite: string): boolean {
  return /^COPIA\b/i.test(tramite.trim());
}

// Marca los pasos de las ramas de COPIA (la copia y todo lo que cuelga de ella).
// Recibe UN árbol en orden DFS: el subárbol de un nodo son los nodos siguientes con
// nivel mayor. Así una rama copiada que luego se archiva no se confunde con la
// ubicación real del expediente.
export function marcarCopias(nodos: SeguimientoNode[]): SeguimientoNode[] {
  let copiaNivel: number | null = null;
  return nodos.map((n) => {
    if (copiaNivel !== null && n.nivel > copiaNivel) return { ...n, enCopia: true };
    copiaNivel = esCopia(n.tramite) ? n.nivel : null;
    return { ...n, enCopia: copiaNivel !== null };
  });
}

// Contenido de un <textarea ... id="ID">…</textarea> (el asunto del detalle viene así).
function textareaById(html: string, id: string): string {
  const m = new RegExp(`<textarea[^>]*id="${id}"[^>]*>([\\s\\S]*?)</textarea>`).exec(html);
  return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : '';
}

// Valor de un <input value="X" ... id="ID"> (el value viene antes del id en este
// markup). fromIndex permite tomar una aparición posterior (ej. el 2do txtEstado).
function inputValueById(html: string, id: string, fromIndex = 0): { value: string; index: number } {
  const idPos = html.indexOf(`id="${id}"`, fromIndex);
  if (idPos < 0) return { value: '', index: -1 };
  const tagStart = html.lastIndexOf('<input', idPos);
  const m = /value="([^"]*)"/.exec(html.slice(tagStart, idPos));
  return { value: m ? m[1] : '', index: idPos };
}

// Ejecuta `fn` sobre `items` con concurrencia limitada, preservando el orden.
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Resuelve UN nodo del ruteo a SeguimientoNode: baja su detalle y saca el receptor
// (persona asignada en el destino), la fecha de recepción y el estado del destino.
export async function fetchSeguimientoNode(
  config: Config,
  session: Session,
  n: { depth: number; key: string; title: string },
  opcion: string,
): Promise<SeguimientoNode> {
  const arrow = n.title.indexOf(' -> ');
  const doc = arrow >= 0 ? n.title.slice(0, arrow).trim() : n.title;
  const destino = arrow >= 0 ? n.title.slice(arrow + 4).trim() : '';
  let receptor = '';
  let fecha: string | null = null;
  let fechaEmision: string | null = null;
  let estado = '';
  let asunto = '';
  let tramite = '';
  try {
    const det = await postDocObjeto(config, session, 'goDetalleSeguimiento', { pkEmi: n.key, opcion });
    const rec = inputValueById(det, 'txtReceptor');
    receptor = rec.value;
    fecha = (inputValueById(det, 'txtFechaRecepcion').value.match(/\d{2}\/\d{2}\/\d{4}/) ?? [null])[0];
    // (sic) el id del servidor es "txtFechaEmsion".
    fechaEmision = (inputValueById(det, 'txtFechaEmsion').value.match(/\d{2}\/\d{2}\/\d{4}/) ?? [null])[0];
    // hay dos txtEstado (remitente y destino); el del destino va después del receptor.
    estado = inputValueById(det, 'txtEstado', rec.index >= 0 ? rec.index : 0).value;
    asunto = textareaById(det, 'txtAsunto');
    tramite = inputValueById(det, 'txtMotivo').value; // rotulado "Trámite:" en el SGD
  } catch {
    /* nodo sin detalle: receptor/fecha/estado/asunto quedan vacíos */
  }
  return { nivel: n.depth, ...decodePkEmi(n.key), doc, destino, receptor, fecha, fechaEmision, estado, asunto, tramite, enCopia: false };
}

// Nodo del ruteo SIN detalle: solo lo que trae el árbol (ids, doc, destino). El
// modo lote recorre así el árbol entero y pide el detalle solo de los candidatos.
export function seguimientoNodeLigero(n: { depth: number; key: string; title: string }): SeguimientoNode {
  const arrow = n.title.indexOf(' -> ');
  const doc = arrow >= 0 ? n.title.slice(0, arrow).trim() : n.title;
  const destino = arrow >= 0 ? n.title.slice(arrow + 4).trim() : '';
  return { nivel: n.depth, ...decodePkEmi(n.key), doc, destino, receptor: '', fecha: null, fechaEmision: null, estado: '', asunto: '', tramite: '', enCopia: false };
}

// Seguimiento COMPLETO de un documento: recorre el árbol de ruteo (goDocSeguimiento*)
// -cada nodo es "TIPO NUMERO -> DEPENDENCIA DESTINO", profundidad dinámica- y por
// cada nodo trae el detalle (goDetalleSeguimiento) con el RECEPTOR (persona asignada),
// la fecha de recepción y el estado del destino. Un detalle por nodo (lo caro).
export async function collectSeguimiento(
  config: Config,
  session: Session,
  nuAnn: string,
  nuEmi: string,
  nuDes: string,
  opcion: string,
): Promise<SeguimientoNode[]> {
  const nodes = await walkTree(config, session, `${nuAnn}${nuEmi}${nuDes}`, opcion, 'goDocSeguimientoRoot', 'goDocSeguimientoJson');
  // Un detalle por nodo: es lo caro del seguimiento.
  return marcarCopias(await mapPool(nodes, 8, (n) => fetchSeguimientoNode(config, session, n, opcion)));
}
