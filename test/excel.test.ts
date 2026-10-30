// Excel de entrada (validación y límite de 30 únicos) y de salida (formato A/B
// validado). Los archivos se generan en memoria con datos ficticios.
import { describe, expect, test } from 'bun:test';
import writeXlsxFile from 'write-excel-file/node';
import { readSheet } from 'read-excel-file/node';
import { unzipSync, strFromU8 } from 'fflate';
import { leerExcelEntrada } from '../src/excel/read-input.ts';
import { ENCABEZADOS, escribirExcelSalida } from '../src/excel/write-output.ts';
import type { ResultadoLote } from '../src/sgd/commands/lote.ts';
import type { Ubicacion } from '../src/sgd/commands/ubicacion.ts';
import { AppError } from '../src/sgd/lib/errors.ts';

const exp = (n: number) => `EXP-2026${String(n).padStart(7, '0')}`;

async function excelDe(filas: (string | number | null)[][]): Promise<Buffer> {
  return writeXlsxFile(filas.map((f) => f.map((v) => (v === null ? null : { value: v })))).toBuffer();
}

async function errorDe(p: Promise<unknown>): Promise<AppError> {
  const e = await p.catch((err: unknown) => err);
  expect(e).toBeInstanceOf(AppError);
  return e as AppError;
}

describe('Excel de entrada', () => {
  test('lee la columna A desde la fila 2, limpia espacios y descarta duplicados y vacíos', async () => {
    const archivo = await excelDe([
      ['Número de expediente (SGD)', 'otra columna'],
      [exp(1), 'x'],
      [`  ${exp(2)} `, 'y'],
      [exp(1), 'z'],
      [null, 'sin expediente'],
      ['ABC DE20260000006', ''],
    ]);
    const r = await leerExcelEntrada(archivo);
    expect(r.terminos).toEqual([exp(1), exp(2), 'ABC DE20260000006']);
    expect(r.filas).toBe(4);
    expect(r.duplicados).toBe(1);
  });

  test('acepta 30 únicos aunque haya más filas por duplicados', async () => {
    const filas = Array.from({ length: 30 }, (_, i) => [exp(i)]);
    const archivo = await excelDe([['Expediente'], ...filas, ...filas.slice(0, 5)]);
    const r = await leerExcelEntrada(archivo);
    expect(r.terminos).toHaveLength(30);
    expect(r.duplicados).toBe(5);
  });

  test('rechaza más de 30 únicos con un mensaje que menciona a TI', async () => {
    const archivo = await excelDe([['Expediente'], ...Array.from({ length: 31 }, (_, i) => [exp(i)])]);
    const e = await errorDe(leerExcelEntrada(archivo));
    expect(e.code).toBe('usage');
    expect(e.message).toContain('31');
    expect(e.hint).toContain('TI');
  });

  test('rechaza un archivo cuyo A1 es un nº de expediente (falta el encabezado)', async () => {
    const archivo = await excelDe([[exp(1)], [exp(2)]]);
    const e = await errorDe(leerExcelEntrada(archivo));
    expect(e.message).toContain('encabezado');
  });

  test('rechaza un archivo sin expedientes', async () => {
    const archivo = await excelDe([['Expediente'], [null]]);
    const e = await errorDe(leerExcelEntrada(archivo));
    expect(e.message).toContain('no hay números');
  });

  test('rechaza un archivo que no es Excel', async () => {
    const e = await errorDe(leerExcelEntrada(Buffer.from('esto no es un xlsx')));
    expect(e.message).toContain('no es un Excel');
  });

  test('rechaza un archivo vacío', async () => {
    const e = await errorDe(leerExcelEntrada(Buffer.alloc(0)));
    expect(e.message).toContain('vacío');
  });
});

describe('Excel de salida', () => {
  const ubic = (estado: string, dependencia: string, asunto = 'ASUNTO', documento = 'INFORME 1'): Ubicacion => ({
    estado,
    dependencia,
    asunto,
    documento,
    receptor: 'PERSONA',
    fecha: '01/10/2026',
  });

  const resultados: ResultadoLote[] = [
    { term: exp(1), ok: true, count: 2, nodos: 4, ubicacion: ubic('ARCHIVADO', 'TESORERIA'), ubicacionOrigen: ubic('ARCHIVADO', 'TESORERIA'), difiere: false },
    { term: exp(2), ok: true, count: 1, nodos: 6, ubicacion: ubic('RECIBIDO', 'LOGISTICA'), ubicacionOrigen: ubic('EN TRAMITE', 'ECONOMIA'), difiere: true },
    { term: exp(3), ok: false, count: 0, nodos: 0, ubicacion: null, ubicacionOrigen: null, difiere: false, error: 'sin coincidencias en tus dependencias' },
  ];

  async function hojas(buffer: Buffer) {
    const archivos = unzipSync(new Uint8Array(buffer));
    return { estilos: strFromU8(archivos['xl/styles.xml']), hoja: strFromU8(archivos['xl/worksheets/sheet1.xml']) };
  }

  test('escribe encabezados y columnas A-J con el formato validado', async () => {
    const filas = await readSheet(await escribirExcelSalida(resultados));
    expect(filas[0]).toEqual(ENCABEZADOS);
    expect(filas[1]).toEqual([exp(1), 'ARCHIVADO', 'TESORERIA', 'ASUNTO', 'INFORME 1', 'ARCHIVADO', 'TESORERIA', 'ASUNTO', 'INFORME 1', null]);
    expect(filas[2]?.[9]).toBe('SI');
    expect(filas[2]?.slice(5, 7)).toEqual(['EN TRAMITE', 'ECONOMIA']);
    expect(filas[3]?.[1]).toBe('NO ENCONTRADO');
  });

  test('resalta en FFF2CC solo cuando hay filas con A≠B', async () => {
    const conDiferencia = await hojas(await escribirExcelSalida(resultados));
    expect(conDiferencia.estilos).toContain('FFF2CC');
    const sinDiferencia = await hojas(await escribirExcelSalida([resultados[0], resultados[2]]));
    expect(sinDiferencia.estilos).not.toContain('FFF2CC');
  });

  test('un asunto que empieza con "=" queda como texto, nunca como fórmula', async () => {
    const malicioso: ResultadoLote = { ...resultados[0], ubicacion: ubic('ARCHIVADO', 'TESORERIA', '=HYPERLINK("http://x","clic")') };
    const buffer = await escribirExcelSalida([malicioso]);
    const { hoja } = await hojas(buffer);
    expect(hoja).not.toContain('<f>');
    const filas = await readSheet(buffer);
    expect(filas[1]?.[3]).toBe('=HYPERLINK("http://x","clic")');
  });
});
