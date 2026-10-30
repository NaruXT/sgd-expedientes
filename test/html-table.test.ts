// Test del extractor de grilla. Fragmento sintético con la forma que la recon
// documentó para Recepción (report.md:109), SIN PII: nombres inventados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTable, normalizeKey } from '../src/sgd/lib/html-table.ts';

const FRAGMENT = `
<div>
<table class="myTableFixed">
  <thead>
    <tr>
      <th>N&deg;</th><th>F. EMISION</th><th>REMITENTE</th><th>TIPO DOC.</th>
      <th>N&deg; DOCUMENTO</th><th>DESTINATARIO</th><th>ASUNTO</th>
      <th>NRO EXPEDIENTE</th><th>ESTADO</th>
    </tr>
  </thead>
  <tbody>
    <tr tabindex="0">
      <td>1</td><td>05/09/2026</td><td>OFICINA A</td><td>OFICIO</td>
      <td>OF-001-2026</td><td>OFICINA B</td><td>Solicitud de informaci&oacute;n</td>
      <td>EXP-777</td><td>No le&iacute;do</td>
      <td><a onclick="fn_verDocumento('2026', '0003037969','DocRecepTablaBtn');">ver</a>
          <a onclick="fn_verAnexo('2026', '0003037969', '3','DocRecepTablaAnexoBtn');">anexos</a></td>
    </tr>
    <tr tabindex="0">
      <td>2</td><td>04/09/2026</td><td>OFICINA C</td><td>MEMO</td>
      <td>ME-002-2026</td><td>OFICINA B</td><td>Reuni&oacute;n de coordinaci&oacute;n</td>
      <td>EXP-778</td><td>Le&iacute;do</td>
      <td><a onclick="fn_verDocumento('2026', '0003037970','DocRecepTablaBtn');">ver</a></td>
    </tr>
  </tbody>
</table>
</div>`;

test('normalizeKey produce claves estables sin acentos', () => {
  assert.equal(normalizeKey('F. EMISION'), 'f_emision');
  assert.equal(normalizeKey('N° DOCUMENTO'), 'n_documento');
  assert.equal(normalizeKey('ASUNTO'), 'asunto');
});

test('extractTable lee headers y filas de la grilla myTableFixed', () => {
  const t = extractTable(FRAGMENT);
  assert.equal(t.rowCount, 2);
  assert.equal(t.headers.length, 9);
  assert.equal(t.headers[1]?.key, 'f_emision');
  const r0 = t.rows[0]!;
  assert.equal(r0.remitente, 'OFICINA A');
  assert.equal(r0.asunto, 'Solicitud de información'); // entidades decodificadas
  assert.equal(r0.estado, 'No leído');
});

test('extractTable captura nuAnn/nuEmi del handler fn_verDocumento', () => {
  const t = extractTable(FRAGMENT);
  const ids = JSON.parse(t.rows[0]!._ids ?? '{}');
  assert.equal(ids.nuAnn, '2026');
  assert.equal(ids.nuEmi, '0003037969');
});

test('extractTable captura nuDes del handler fn_verAnexo (para documento anexos)', () => {
  const t = extractTable(FRAGMENT);
  const ids = JSON.parse(t.rows[0]!._ids ?? '{}');
  assert.equal(ids.nuDes, '3');
  assert.equal(ids.opcion, 'DocRecepTablaAnexoBtn');
});

test('extractTable con HTML basura no explota', () => {
  const t = extractTable('<html><body>sin tabla</body></html>');
  assert.equal(t.rowCount, 0);
  assert.equal(t.headers.length, 0);
});

test('extractTable tolera tabla sin thead (headers en primera fila td)', () => {
  const t = extractTable('<table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>');
  assert.equal(t.rowCount, 1);
  assert.equal(t.rows[0]?.a, '1');
});
