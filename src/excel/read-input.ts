// Lectura del Excel de entrada: primera hoja, columna A, encabezado en la fila 1 y un
// nº de expediente por fila. El límite se aplica a expedientes ÚNICOS tras limpiar
// espacios: los duplicados no consumen cupo.
import { readSheet } from 'read-excel-file/node';
import { AppError } from '../sgd/lib/errors.ts';
import { looksLikeExpediente } from '../sgd/commands/expediente.ts';
import { LIMITE_TERMINOS, normalizarTerminos } from '../sgd/commands/lote.ts';

export const MAX_BYTES_EXCEL = 1_000_000;
const MAX_FILAS = 2000; // tope de filas leídas: muy por encima de un uso real de 30 únicos

export interface EntradaExcel {
  terminos: string[]; // únicos, en orden de aparición
  filas: number; // filas con dato en la columna A (sin contar el encabezado)
  duplicados: number; // filas repetidas que no consumen cupo
}

export async function leerExcelEntrada(contenido: Buffer): Promise<EntradaExcel> {
  if (contenido.length === 0) throw new AppError('usage', 'el archivo está vacío');
  if (contenido.length > MAX_BYTES_EXCEL) {
    throw new AppError('usage', 'el archivo es demasiado grande para una consulta de hasta 30 expedientes');
  }

  let filasHoja: unknown[][];
  try {
    filasHoja = (await readSheet(contenido)) as unknown[][];
  } catch {
    throw new AppError('usage', 'el archivo no es un Excel (.xlsx) válido', {
      hint: 'guarda el archivo como "Libro de Excel (.xlsx)" y vuelve a cargarlo',
    });
  }

  if (filasHoja.length > MAX_FILAS + 1) {
    throw new AppError('usage', `el archivo tiene más de ${MAX_FILAS} filas`, {
      hint: 'para volúmenes mayores comunícate con TI',
    });
  }

  const encabezado = celdaTexto(filasHoja[0]?.[0]);
  if (encabezado && looksLikeExpediente(encabezado)) {
    throw new AppError('usage', 'la fila 1 debe ser el encabezado y contiene un nº de expediente', {
      hint: 'agrega un encabezado en A1 (por ejemplo "Número de expediente (SGD)") y vuelve a cargar el archivo',
    });
  }

  const valores = filasHoja.slice(1).map((fila) => celdaTexto(fila?.[0])).filter((v) => v !== '');
  const terminos = normalizarTerminos(valores);
  if (terminos.length === 0) {
    throw new AppError('usage', 'no hay números de expediente en la columna A');
  }
  if (terminos.length > LIMITE_TERMINOS) {
    throw new AppError('usage', `el archivo tiene ${terminos.length} expedientes distintos; el máximo es ${LIMITE_TERMINOS}`, {
      hint: 'ajusta el archivo; para volúmenes mayores comunícate con TI',
    });
  }

  return { terminos, filas: valores.length, duplicados: valores.length - terminos.length };
}

// Texto de una celda: los números se escriben sin notación científica ni decimales de más.
function celdaTexto(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toFixed(0) : String(v);
  if (v instanceof Date) return '';
  return String(v).trim();
}
