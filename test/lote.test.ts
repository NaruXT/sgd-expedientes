// Test de las partes puras del modo lote. Datos sintéticos, SIN PII real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leerTerminos } from '../src/sgd/commands/lote.ts';
import { candidatosRecientes, origenPorReferencias, mismaUbicacion } from '../src/sgd/commands/ubicacion.ts';
import { marcarCopias, esCopia } from '../src/sgd/commands/documento.ts';
import type { SeguimientoNode } from '../src/sgd/commands/documento.ts';

function nodo(nuEmi: string, nuDes = '1', receptor = ''): SeguimientoNode {
  return { nivel: 0, nuAnn: '2026', nuEmi, nuDes, doc: 'DOC', destino: 'AREA', receptor, fecha: null, fechaEmision: null, estado: '', asunto: '', tramite: '', enCopia: false };
}

test('leerTerminos limpia espacios y CRLF, descarta vacíos y duplicados, conserva el orden', () => {
  assert.deepEqual(leerTerminos('B-20260000002\r\n  A-20260000001 \n\nB-20260000002\nABC DE20260000006\n'), [
    'B-20260000002',
    'A-20260000001',
    'ABC DE20260000006',
  ]);
});

test('candidatosRecientes conserva los nodos de los N documentos más recientes por nuEmi (todos sus destinos)', () => {
  const nodos = [nodo('0000000100'), nodo('0000000300', '1', 'X'), nodo('0000000300', '2', 'Y'), nodo('0000000200'), nodo('0000000050')];
  const out = candidatosRecientes(nodos, 2);
  assert.deepEqual(out.map((n) => `${n.nuEmi}/${n.nuDes}`), ['0000000300/1', '0000000300/2', '0000000200/1']);
});

test('candidatosRecientes ordena por año antes que por correlativo', () => {
  const viejo = { ...nodo('0000009999'), nuAnn: '2025' };
  const nuevo = nodo('0000000001');
  assert.deepEqual(candidatosRecientes([viejo, nuevo], 1).map((n) => n.nuAnn), ['2026']);
});

function paso(nivel: number, tramite: string, destino: string): SeguimientoNode {
  return { ...nodo('0000000001'), nivel, tramite, destino };
}

test('esCopia reconoce solo el trámite COPIA', () => {
  assert.equal(esCopia('COPIA'), true);
  assert.equal(esCopia(' copia '), true);
  assert.equal(esCopia('ORIGINAL'), false);
  assert.equal(esCopia('PARA CONOCIMIENTO Y FINES'), false);
  assert.equal(esCopia(''), false);
});

test('marcarCopias marca la copia y todo su subárbol, y retoma en la rama hermana', () => {
  // Forma del caso real: un informe a 2 destinos; la copia a Farmacia se archiva debajo.
  const arbol = [
    paso(0, 'ORIGINAL', 'ABC'),
    paso(1, 'ORIGINAL', 'PROCESO DE SELECCION'),
    paso(1, 'COPIA', 'FARMACIA'),
    paso(2, 'PARA CONOCIMIENTO Y FINES', 'FARMACIA'),
    paso(3, 'ATENDER', 'NIETO DE LA COPIA'),
    paso(1, 'ATENDER', 'OTRA RAMA'),
  ];
  assert.deepEqual(marcarCopias(arbol).map((n) => n.enCopia), [false, false, true, true, true, false]);
});

function ref(depth: number, key: string) {
  return { depth, key };
}

test('origenPorReferencias sube por una cadena lineal hasta el documento sin antecedentes', () => {
  // HOJA DE ENVIO -> PROVEIDO -> NOTA DE PEDIDO (origen, sin referencias)
  assert.equal(origenPorReferencias([ref(0, 'HOJA'), ref(1, 'PROVEIDO'), ref(2, 'NOTA')]), 'NOTA');
});

test('origenPorReferencias para en el documento que cita VARIOS antecedentes (no se cuela otro expediente)', () => {
  // NOTA INFORMATIVA -> NOTA DE PEDIDO, que cita 2 informes de otro trámite
  const arbol = [ref(0, 'NOTA INF'), ref(1, 'NOTA PEDIDO'), ref(2, 'INFORME 105'), ref(2, 'INFORME 100'), ref(3, 'MAS VIEJO')];
  assert.equal(origenPorReferencias(arbol), 'NOTA PEDIDO');
});

test('origenPorReferencias: documento sin referencias es su propio origen; árbol vacío -> null', () => {
  assert.equal(origenPorReferencias([ref(0, 'SOLO')]), 'SOLO');
  assert.equal(origenPorReferencias([]), null);
});

test('mismaUbicacion compara estado, dependencia y documento', () => {
  const u = { dependencia: 'TESORERIA', receptor: 'X', estado: 'ARCHIVADO', asunto: 'A', documento: 'HOJA 1', fecha: '01/01/2026' };
  assert.equal(mismaUbicacion(u, { ...u, receptor: 'OTRO', asunto: 'B' }), true);
  assert.equal(mismaUbicacion(u, { ...u, dependencia: 'LOGISTICA' }), false);
  assert.equal(mismaUbicacion(null, null), true);
  assert.equal(mismaUbicacion(u, null), false);
});
