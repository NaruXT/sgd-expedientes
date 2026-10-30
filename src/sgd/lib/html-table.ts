// Extractor de grilla tolerante. La recon no guardó HTML de respuesta (se borró
// por PII) y el stack es fin de vida ("cualquier retoque de plantilla rompe el
// parser"), así que este extractor es genérico y dirigido por headers en vez de
// mapear columnas fijas por conector. Aislado a propósito: si el markup cambia,
// se toca solo este archivo.

export interface TableHeader {
  key: string; // clave estable normalizada, ej. "f_emision"
  label: string; // etiqueta visible original, ej. "F. EMISION"
}

export interface ExtractedTable {
  headers: TableHeader[];
  rows: Record<string, string>[]; // cada fila keyed por header.key (+ _ids si hay)
  rowCount: number;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ntilde: 'ñ',
  Ntilde: 'Ñ',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú',
  uuml: 'ü',
  ordm: 'º',
  ordf: 'ª',
  deg: '°',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, ent) ? NAMED_ENTITIES[ent] : m;
  });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeKey(label: string): string {
  const text = stripTags(label)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // quita acentos (marcas combinantes)
  const key = text.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return key || 'col';
}

// Selecciona la tabla objetivo: la de clase myTableFixed si existe, si no la
// tabla con más filas <tr>.
function selectTable(html: string): string | null {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  if (tables.length === 0) return null;
  const fixed = tables.find((t) => /class\s*=\s*["'][^"']*myTableFixed/i.test(t));
  if (fixed) return fixed;
  let best = tables[0];
  let bestRows = -1;
  for (const t of tables) {
    const n = (t.match(/<tr[\s>]/gi) ?? []).length;
    if (n > bestRows) {
      bestRows = n;
      best = t;
    }
  }
  return best ?? null;
}

function cellsOf(rowHtml: string, tag: 'td' | 'th'): string[] {
  // Captura celdas normales <x>...</x> Y auto-cerradas <x ... />. El SGD emite
  // las columnas ocultas (nuAnn, nuEmi, códigos) como <th ... /> auto-cerrados;
  // si no se cuentan, los headers (15) quedan desalineados con las celdas de
  // datos (15) y cada columna se lee corrida. Se preserva el orden de aparición.
  const re = new RegExp(`<${tag}\\b[^>]*?/>|<${tag}\\b[^>]*?>[\\s\\S]*?</${tag}>`, 'gi');
  const raw = rowHtml.match(re) ?? [];
  return raw.map((c) => stripTags(c));
}

// Identificadores de documento a nivel fila, para `documento ver|descargar`.
// Los handlers de la grilla los pasan como args: fn_verDocumento('YYYY','NNNN',...),
// fn_verAnexo('YYYY','NNNN',...), editarDocumentoRecepClick('YYYY','NNNN',...).
// Los dos primeros args entre comillas son nuAnn (año) y nuEmi (nº de documento).
function extractIds(rowHtml: string): Record<string, string> {
  const ids: Record<string, string> = {};
  const call = /\(\s*'(\d{4})'\s*,\s*'(\d+)'/.exec(rowHtml);
  if (call) {
    ids.nuAnn = call[1];
    ids.nuEmi = call[2];
  }
  // fn_verAnexo('YYYY','NNNN','<nuDes>','<opcion>') expone nuDes y la opción,
  // necesarios para listar los anexos. nuDes puede ser un dígito (recepción, ej.
  // '3') o una letra (emisión usa 'N'), por eso se acepta cualquier no-comilla.
  const anexo = /fn_verAnexo\w*\(\s*'(\d{4})'\s*,\s*'(\d+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'/.exec(rowHtml);
  if (anexo) {
    ids.nuAnn = ids.nuAnn ?? anexo[1];
    ids.nuEmi = ids.nuEmi ?? anexo[2];
    ids.nuDes = anexo[3];
    ids.opcion = anexo[4];
  }
  // Fallback: por si algún conector los expone como nuAnn=.../nuEmi=... en query.
  if (!ids.nuAnn) {
    const a = /nuAnn\s*[=:]\s*['"]?(\d+)/i.exec(rowHtml);
    if (a) ids.nuAnn = a[1];
  }
  if (!ids.nuEmi) {
    const e = /nuEmi\s*[=:]\s*['"]?(\d+)/i.exec(rowHtml);
    if (e) ids.nuEmi = e[1];
  }
  return ids;
}

export function extractTable(html: string): ExtractedTable {
  const table = selectTable(html);
  if (!table) return { headers: [], rows: [], rowCount: 0 };

  const rowMatches = table.match(/<tr[\s>][\s\S]*?<\/tr>/gi) ?? [];
  if (rowMatches.length === 0) return { headers: [], rows: [], rowCount: 0 };

  // Encabezados: primera fila con <th>, o la primera fila si no hay <th>.
  let headerLabels: string[] = [];
  let dataStart = 0;
  const firstThRowIdx = rowMatches.findIndex((r) => /<th[\s>]/i.test(r));
  if (firstThRowIdx !== -1) {
    headerLabels = cellsOf(rowMatches[firstThRowIdx] ?? '', 'th');
    dataStart = firstThRowIdx + 1;
  } else {
    headerLabels = cellsOf(rowMatches[0] ?? '', 'td');
    dataStart = 1;
  }

  // Claves únicas y estables por columna.
  const seen: Record<string, number> = {};
  const headers: TableHeader[] = headerLabels.map((label, i) => {
    let key = normalizeKey(label) || `col_${i + 1}`;
    if (seen[key] != null) {
      seen[key] += 1;
      key = `${key}_${seen[key]}`;
    } else {
      seen[key] = 0;
    }
    return { key, label: stripTags(label) };
  });

  const rows: Record<string, string>[] = [];
  for (let i = dataStart; i < rowMatches.length; i++) {
    const rowHtml = rowMatches[i];
    const cells = cellsOf(rowHtml, 'td');
    if (cells.length === 0) continue; // salta filas de control/paginación sin <td>
    const row: Record<string, string> = {};
    for (let c = 0; c < cells.length; c++) {
      const key = headers[c]?.key ?? `col_${c + 1}`;
      row[key] = cells[c];
    }
    const ids = extractIds(rowHtml);
    if (Object.keys(ids).length > 0) row._ids = JSON.stringify(ids);
    rows.push(row);
  }

  return { headers, rows, rowCount: rows.length };
}
