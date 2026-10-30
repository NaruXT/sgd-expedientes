// Excel de salida del lote, con el formato validado por el usuario:
//   A = expediente
//   B-E = ubicación A (desde tus documentos): estado, dependencia, asunto, último documento
//   F-I = ubicación B (desde el origen del expediente)
//   J = "SI" si A y B difieren
// Las filas con A≠B se resaltan en amarillo (FFF2CC) para revisarlas a mano.
import writeXlsxFile from 'write-excel-file/node';
import type { Cell, CellObject, Row } from 'write-excel-file/node';
import type { ResultadoLote } from '../sgd/commands/lote.ts';
import type { Ubicacion } from '../sgd/commands/ubicacion.ts';

export const RESALTADO = '#FFF2CC';

export const ENCABEZADOS = [
  'Número de expediente (SGD)',
  'ESTADO',
  'DEPENDENCIA',
  'ASUNTO',
  'ULTIMO DOCUMENTO',
  'ESTADO (ORIGEN)',
  'DEPENDENCIA (ORIGEN)',
  'ASUNTO (ORIGEN)',
  'ULTIMO DOCUMENTO (ORIGEN)',
  'A ≠ ORIGEN',
];

const ANCHOS = [26, 16, 30, 45, 34, 16, 30, 45, 34, 12];
const COLUMNAS_ASUNTO = new Set([3, 7]); // índices 0-based de las columnas de asunto

function ubicacionCeldas(u: Ubicacion | null): string[] {
  return u ? [u.estado, u.dependencia, u.asunto, u.documento] : ['', '', '', ''];
}

export function filasSalida(resultados: ResultadoLote[]): string[][] {
  return resultados.map((r) => {
    const a = r.ubicacion ? ubicacionCeldas(r.ubicacion) : ['NO ENCONTRADO', '', '', ''];
    return [r.term, ...a, ...ubicacionCeldas(r.ubicacionOrigen), r.difiere ? 'SI' : ''];
  });
}

export async function escribirExcelSalida(resultados: ResultadoLote[]): Promise<Buffer> {
  const encabezado: Row = ENCABEZADOS.map((value): CellObject => ({
    value,
    type: String,
    fontWeight: 'bold',
    wrap: true,
    alignVertical: 'center',
    borderStyle: 'thin',
  }));

  const datos: Row[] = filasSalida(resultados).map((valores, i) => {
    const difiere = resultados[i].difiere;
    return valores.map((value, col): Cell => ({
      value,
      // Siempre texto: un asunto que empiece con "=" nunca se interpreta como fórmula.
      type: String,
      alignVertical: 'top',
      borderStyle: 'thin',
      ...(COLUMNAS_ASUNTO.has(col) ? { wrap: true } : {}),
      ...(difiere ? { backgroundColor: RESALTADO } : {}),
    }));
  });

  return writeXlsxFile([encabezado, ...datos], {
    sheet: 'Ubicación',
    columns: ANCHOS.map((width) => ({ width })),
    stickyRowsCount: 1,
  }).toBuffer();
}
