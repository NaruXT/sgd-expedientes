// Test de los formateadores del listado de documentos del expediente y del selector
// del nodo actual del ruteo. Datos sintéticos con nombres inventados, SIN PII real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchLabel, matchContexto, matchEstado, matchActual, looksLikeExpediente } from '../src/sgd/commands/expediente.ts';
import { docActualNode, ubicacionDe, raicesDelExpediente, seguimientoDelExpediente } from '../src/sgd/commands/ubicacion.ts';
import type { Match } from '../src/sgd/commands/expediente.ts';
import type { SeguimientoNode } from '../src/sgd/commands/documento.ts';

function match(over: Partial<Match> = {}): Match {
  return {
    dependencia: 'PRESUPUESTO', sigla: 'OFI-ABC', coDep: '10018', bandeja: 'emision',
    fecha: '26/01/2026', nuAnn: '2026', nuEmi: '0003007158', nuDes: 'N',
    tipo: 'PROVEIDO', nroDocumento: '000027-2026-OFI-ABC', expediente: 'EXP-UT20230000505',
    asunto: 'DISPONIBILIDAD PRESUPUESTAL', estado: 'RECIBIDO', origen: 'PROGRAMACION',
    destinatario: '', cadena: null, seguimiento: null, ...over,
  };
}

function nodo(over: Partial<SeguimientoNode> = {}): SeguimientoNode {
  return { nivel: 0, nuAnn: '2026', nuEmi: '0000000001', nuDes: '1', doc: 'INFORME 001-2025', destino: 'AREA Y', receptor: '', fecha: null, fechaEmision: null, estado: '', asunto: '', tramite: 'ORIGINAL', enCopia: false, ...over };
}

test('matchLabel arma "TIPO Nº" como la grilla web', () => {
  assert.equal(matchLabel(match()), 'PROVEIDO 000027-2026-OFI-ABC');
});

test('matchLabel sin tipo cae al nº de documento', () => {
  assert.equal(matchLabel(match({ tipo: '', nroDocumento: '000203-2026-OFI-ABC' })), '000203-2026-OFI-ABC');
});

test('matchLabel sin tipo ni nº cae a nuAnn-nuEmi', () => {
  assert.equal(matchLabel(match({ tipo: '', nroDocumento: '' })), '2026-0003007158');
});

test('matchContexto arma origen · fecha (el estado va en el encabezado del grupo)', () => {
  assert.equal(
    matchContexto(match({ origen: 'EQUIPO DE LOGISTICA', fecha: '18/02/2026' })),
    'EQUIPO DE LOGISTICA · 18/02/2026',
  );
});

test('matchContexto omite las partes vacías sin dejar separadores sueltos', () => {
  assert.equal(matchContexto(match({ origen: '', fecha: '02/03/2026' })), '02/03/2026');
});

test('matchEstado limpia el prefijo de orden y agrupa por estado', () => {
  assert.equal(matchEstado(match({ estado: '0_DERIVADO' })), 'DERIVADO');
  assert.equal(matchEstado(match({ estado: 'RECIBIDO' })), 'RECIBIDO');
});

test('matchEstado sin estado cae a una etiqueta legible', () => {
  assert.equal(matchEstado(match({ estado: '' })), '(sin estado)');
});

test('matchActual usa el destinatario de emisión tal cual (ya trae ÁREA - PERSONA)', () => {
  assert.equal(
    matchActual(match({ bandeja: 'emision', destinatario: 'PRESUPUESTO - PEREZ GOMEZ JUAN CARLOS' })),
    'PRESUPUESTO - PEREZ GOMEZ JUAN CARLOS',
  );
});

test('matchActual en recepción reconstruye ÁREA - PERSONA con la dependencia del nodo', () => {
  assert.equal(
    matchActual(match({ bandeja: 'recepcion', sigla: 'ABC', destinatario: 'RAMOS TORRES ANA MARIA' })),
    'ABC - RAMOS TORRES ANA MARIA',
  );
});

test('matchActual sin destinatario cae a un placeholder', () => {
  assert.equal(matchActual(match({ destinatario: '' })), '(sin destinatario)');
});

test('docActualNode elige el hop más reciente por fecha, no el último del array (árbol ramificado)', () => {
  const nodos = [
    nodo({ nivel: 3, fecha: '23/01/2026', destino: 'TESORERIA', receptor: 'ACTUAL' }),
    nodo({ nivel: 5, fecha: '17/12/2025', destino: 'RAMA VIEJA', receptor: 'VIEJO' }),
  ];
  assert.equal(docActualNode(nodos)?.receptor, 'ACTUAL');
});

test('docActualNode desempata por profundidad a igual fecha (el más avanzado en la cadena)', () => {
  const nodos = [
    nodo({ nivel: 2, fecha: '30/12/2025', receptor: 'SUPERFICIAL' }),
    nodo({ nivel: 8, fecha: '30/12/2025', receptor: 'PROFUNDO' }),
  ];
  assert.equal(docActualNode(nodos)?.receptor, 'PROFUNDO');
});

test('docActualNode con ruteo vacío devuelve null', () => {
  assert.equal(docActualNode([]), null);
});

test('docActualNode toma un envío aún no recibido como actual (cae a la fecha de emisión)', () => {
  const nodos = [
    nodo({ nivel: 1, fecha: '10/03/2026', fechaEmision: '09/03/2026', receptor: 'RECIBIO ANTES' }),
    nodo({ nivel: 2, fecha: null, fechaEmision: '12/03/2026', receptor: 'PENDIENTE DE RECIBIR' }),
  ];
  assert.equal(docActualNode(nodos)?.receptor, 'PENDIENTE DE RECIBIR');
});

test('ubicacionDe resume el último paso: dependencia, receptor, estado limpio y asunto', () => {
  const nodos = [
    nodo({ nivel: 0, fecha: '01/02/2026', destino: 'AREA X', estado: 'DERIVADO' }),
    nodo({
      nivel: 1, fecha: '05/02/2026', doc: 'HOJA DE ENVIO 000123-2026-TES', destino: 'TESORERIA',
      receptor: 'PEREZ GOMEZ JUAN', estado: '0_ARCHIVADO', asunto: 'OC 1 / SIAF 2 / FACTURA E001-3',
    }),
  ];
  assert.deepEqual(ubicacionDe(nodos), {
    dependencia: 'TESORERIA', receptor: 'PEREZ GOMEZ JUAN', estado: 'ARCHIVADO',
    asunto: 'OC 1 / SIAF 2 / FACTURA E001-3', documento: 'HOJA DE ENVIO 000123-2026-TES', fecha: '05/02/2026',
  });
});

test('ubicacionDe sin ruteo devuelve null', () => {
  assert.equal(ubicacionDe([]), null);
});

test('raicesDelExpediente usa solo documentos de las coincidencias, nunca la cadena de referencias', () => {
  // La cadena trae un informe ajeno MÁS ANTIGUO (otro expediente, citado como referencia).
  const ajeno = { nivel: 1, nuAnn: '2026', nuEmi: '0000000001', nuDes: '1', titulo: 'INFORME AJENO', fecha: null, emisor: '', destino: '', anexos: [] };
  const m = match({ bandeja: 'recepcion', nuEmi: '0000000500', nuDes: '2', cadena: { raiz: { nuAnn: '2026', nuEmi: '0000000500', nuDes: '2' }, totalDocumentos: 2, totalAnexos: 0, documentos: [ajeno] } });
  assert.deepEqual(raicesDelExpediente([m]).map((r) => r.nuEmi), ['0000000500']);
});

test('raicesDelExpediente: una por documento, en orden de emisión, prefiriendo la fila de recepción', () => {
  const emi = match({ bandeja: 'emision', nuEmi: '0000000700', nuDes: 'N' });
  const rec = match({ bandeja: 'recepcion', nuEmi: '0000000700', nuDes: '1' });
  const viejo = match({ bandeja: 'recepcion', nuEmi: '0000000300', nuDes: '1' });
  assert.deepEqual(raicesDelExpediente([emi, rec, viejo]).map((r) => `${r.nuEmi}/${r.nuDes}`), ['0000000300/1', '0000000700/1']);
});

test('seguimientoDelExpediente salta raíces ya cubiertas y deduplica nodos', async () => {
  const arboles: Record<string, SeguimientoNode[]> = {
    '0000000100': [nodo({ nuEmi: '0000000100', receptor: 'A' }), nodo({ nuEmi: '0000000200', receptor: 'B' })],
    '0000000300': [nodo({ nuEmi: '0000000300', receptor: 'C' }), nodo({ nuEmi: '0000000200', receptor: 'B' })],
  };
  const llamadas: string[] = [];
  const raiz = (nuEmi: string) => ({ nuAnn: '2026', nuEmi, nuDes: '1', opcion: 'x' });
  const out = await seguimientoDelExpediente([raiz('0000000100'), raiz('0000000200'), raiz('0000000300')], async (r) => {
    llamadas.push(r.nuEmi);
    return arboles[r.nuEmi] ?? [];
  });
  assert.deepEqual(llamadas, ['0000000100', '0000000300']); // 200 ya venía en el árbol de 100
  assert.deepEqual(out.map((n) => n.receptor), ['A', 'B', 'C']);
});

test('looksLikeExpediente reconoce nº de expediente, incluso con un espacio en el prefijo', () => {
  assert.equal(looksLikeExpediente('EXP-SU20260000404'), true);
  assert.equal(looksLikeExpediente('ABC DE20260000006'), true);
  assert.equal(looksLikeExpediente('EX000020260000606'), true);
});

test('looksLikeExpediente rechaza texto libre de asunto', () => {
  assert.equal(looksLikeExpediente('presupuesto'), false);
  assert.equal(looksLikeExpediente('materiales para macroscopia'), false);
  assert.equal(looksLikeExpediente('factura de 20260000006 soles'), false);
});

test('docActualNode ignora las ramas de COPIA aunque sean más recientes (caso real: copia archivada después)', () => {
  const nodos = [
    nodo({ nivel: 8, fecha: null, fechaEmision: '20/10/2026', destino: 'ADQUISICIONES', estado: 'NO LEIDO' }),
    nodo({ nivel: 2, fecha: '21/10/2026', destino: 'AREA COPIA', estado: 'ARCHIVADO', tramite: 'COPIA', enCopia: true }),
  ];
  assert.equal(docActualNode(nodos)?.destino, 'ADQUISICIONES');
});

test('docActualNode con todo en copia cae al árbol completo antes que no ubicar', () => {
  assert.equal(docActualNode([nodo({ enCopia: true, destino: 'UNICA' })])?.destino, 'UNICA');
});
