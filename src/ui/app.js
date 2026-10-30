// Interfaz de SGD Expedientes. Sin framework. Todo dato que viene del SGD se escribe
// con textContent (nunca innerHTML) para que un asunto con HTML no se ejecute.
'use strict';

const TOKEN = document.querySelector('meta[name="sgd-token"]').content;
const INTERVALO_SONDEO_MS = 700;

const $ = (id) => document.getElementById(id);

// --- API ---

class ApiError extends Error {
  constructor(error) {
    super(error?.message ?? 'no se pudo completar la operación');
    this.code = error?.code ?? 'desconocido';
    this.hint = error?.hint ?? '';
  }
}

async function api(method, path, { json, binario } = {}) {
  const headers = { 'x-sgd-token': TOKEN };
  let body;
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (binario !== undefined) {
    headers['content-type'] = 'application/octet-stream';
    body = binario;
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body });
  } catch {
    throw new ApiError({ code: 'sin_conexion', message: 'la aplicación no responde', hint: 'cierra esta ventana y vuelve a abrir SGD Expedientes' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new ApiError(data.error);
  return data;
}

async function esperarTrabajo(id, alAvanzar) {
  for (;;) {
    const { trabajo } = await api('GET', `/api/trabajos/${id}`);
    alAvanzar?.(trabajo);
    if (trabajo.estado === 'listo') return trabajo.resultado;
    if (trabajo.estado === 'error') throw new ApiError(trabajo.error);
    await new Promise((r) => setTimeout(r, INTERVALO_SONDEO_MS));
  }
}

// --- Utilidades de presentación ---

const mayuscula = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
const limpiarEstado = (s) => (s ?? '').replace(/^\d+_/, '').trim();

function el(tag, props = {}, ...hijos) {
  const nodo = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') nodo.className = v;
    else if (k === 'text') nodo.textContent = v;
    else nodo.setAttribute(k, v);
  }
  for (const h of hijos) if (h) nodo.append(h);
  return nodo;
}

function mostrarAviso(error) {
  $('aviso-mensaje').textContent = mayuscula(error.message ?? String(error));
  $('aviso-pista').textContent = mayuscula(error.hint ?? '');
  $('aviso').hidden = false;
}

function ocultarAviso() {
  $('aviso').hidden = true;
}

// Un error de sesión lleva al login; cualquier otro se muestra como aviso.
async function manejarError(error) {
  mostrarAviso(error);
  if (error.code === 'session_expired' || error.code === 'not_authenticated') await refrescar({ conservarAviso: true });
}

// Deshabilita un botón mientras dura una operación y, si se indica, muestra un texto
// de espera. Al terminar restaura siempre el texto original.
function ocupado(boton, si, textoEspera) {
  boton.disabled = si;
  if (si && textoEspera) {
    boton.dataset.textoOriginal = boton.textContent;
    boton.textContent = textoEspera;
  } else if (!si && boton.dataset.textoOriginal) {
    boton.textContent = boton.dataset.textoOriginal;
    delete boton.dataset.textoOriginal;
  }
}

function textoProgreso(trabajo, porDefecto) {
  const p = trabajo.progreso;
  const nota = trabajo.notas?.at(-1);
  if (trabajo.estado === 'en_cola') return 'En espera…';
  if (p && p.total > 0) return `${mayuscula(p.fase)}: ${p.hechos} de ${p.total}`;
  return mayuscula(nota ?? porDefecto);
}

function actualizarBarra(barra, trabajo) {
  const p = trabajo.progreso;
  if (p && p.total > 0) {
    barra.max = p.total;
    barra.value = p.hechos;
  } else {
    barra.removeAttribute('value'); // barra indeterminada
  }
}

// --- Vistas ---

let estadoActual = null;

function mostrarVista(nombre) {
  $('cargando').hidden = true;
  for (const v of ['config', 'login', 'consulta']) $(`vista-${v}`).hidden = v !== nombre;
  // En configuración no hay pestaña activa: el menú marca solo la consulta visible.
  for (const t of pestanas) t.setAttribute('aria-selected', String(nombre === 'consulta' && !$(t.getAttribute('aria-controls')).hidden));
}

async function refrescar({ conservarAviso = false } = {}) {
  if (!conservarAviso) ocultarAviso();
  estadoActual = await api('GET', '/api/estado');
  const e = estadoActual;
  $('lote-limite').textContent = String(e.limiteTerminos);

  $('cuenta').hidden = !e.usuario;
  $('menu').hidden = !e.usuario;
  $('cuenta-usuario').textContent = e.usuario ?? '';
  $('cuenta-dependencia').textContent = e.dependencia?.nombre ?? '';
  $('pie-version').textContent = e.version ? `Versión ${e.version}` : '';
  $('pie-unidad').hidden = !(e.usuario && e.dependencia);
  $('pie-dependencia').textContent = e.dependencia?.nombre ?? '';

  if (!e.configurado) return abrirConfig();
  if (!e.usuario) {
    $('login-host').textContent = `Servidor: ${e.host}`;
    mostrarVista('login');
    $('login-usuario').focus();
    return;
  }
  mostrarVista('consulta');
}

// Configuración
function abrirConfig() {
  const e = estadoActual;
  $('cfg-host').value = e?.host ?? '';
  $('cfg-ca').value = '';
  $('cfg-ca-estado').textContent = e?.tieneCertificado ? 'Ya hay un certificado guardado. Elige otro archivo solo si quieres reemplazarlo.' : '';
  $('cfg-cancelar').hidden = !e?.configurado;
  mostrarVista('config');
  $('cfg-host').focus();
}

$('form-config').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  ocultarAviso();
  const boton = $('cfg-guardar');
  ocupado(boton, true, 'Guardando…');
  try {
    const cuerpo = { host: $('cfg-host').value.trim() };
    const archivo = $('cfg-ca').files[0];
    if (archivo) cuerpo.ca = await archivo.text();
    await api('PUT', '/api/configuracion', { json: cuerpo });
    await refrescar();
  } catch (error) {
    await manejarError(error);
  } finally {
    ocupado(boton, false);
  }
});

$('cfg-cancelar').addEventListener('click', () => refrescar());
$('btn-config').addEventListener('click', abrirConfig);
$('login-config').addEventListener('click', abrirConfig);

// Sesión
$('form-login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  ocultarAviso();
  const usuario = $('login-usuario').value.trim();
  const clave = $('login-clave').value;
  if (!usuario || !clave) {
    mostrarAviso({ message: 'Escribe tu usuario y contraseña' });
    return;
  }
  const boton = $('login-enviar');
  ocupado(boton, true, 'Ingresando…');
  try {
    const { trabajo } = await api('POST', '/api/sesion', { json: { usuario, clave } });
    await esperarTrabajo(trabajo);
    $('login-clave').value = '';
    await refrescar();
    $('buscar-termino').focus();
  } catch (error) {
    $('login-clave').value = '';
    await manejarError(error);
  } finally {
    ocupado(boton, false);
  }
});

$('btn-salir').addEventListener('click', async () => {
  try {
    await api('DELETE', '/api/sesion');
  } finally {
    limpiarConsulta();
    await refrescar();
  }
});

// Pestañas (con flechas del teclado, como indica ARIA)
const pestanas = [$('tab-uno'), $('tab-lote')];

function elegirPestana(tab) {
  for (const t of pestanas) {
    const activa = t === tab;
    t.tabIndex = activa ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !activa;
  }
  ocultarAviso();
  mostrarVista('consulta');
}

for (const tab of pestanas) {
  tab.addEventListener('click', () => elegirPestana(tab));
  tab.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
    const siguiente = pestanas[(pestanas.indexOf(tab) + (ev.key === 'ArrowRight' ? 1 : pestanas.length - 1)) % pestanas.length];
    elegirPestana(siguiente);
    siguiente.focus();
  });
}

// --- Un expediente ---

function filaDato(dl, etiqueta, valor, clase) {
  if (!valor) return;
  dl.append(el('dt', { text: etiqueta }), el('dd', { text: valor, ...(clase ? { class: clase } : {}) }));
}

function listaUbicacion(u) {
  const dl = el('dl');
  filaDato(dl, 'Estado', limpiarEstado(u.estado) || '(sin dato)', 'estado');
  filaDato(dl, 'Dependencia', u.dependencia || '(sin dato)');
  filaDato(dl, 'Lo tiene', u.receptor);
  filaDato(dl, 'Documento', u.documento);
  filaDato(dl, 'Fecha', u.fecha);
  filaDato(dl, 'Asunto', u.asunto);
  return dl;
}

function renderBusqueda(r) {
  const cont = $('buscar-resultado');
  cont.replaceChildren();

  if (r.ubicacion) {
    const ficha = el('article', { class: 'ficha' }, el('h2', { class: 'ficha-titulo', text: `Expediente ${r.term}` }), listaUbicacion(r.ubicacion));
    if (r.difiere && r.ubicacionOrigen) {
      ficha.append(
        el(
          'div',
          { class: 'ficha-origen' },
          el('h3', { text: 'Otra ubicación según el origen del expediente' }),
          el('p', { text: 'El expediente tiene otra rama que no pasa por tus documentos. Conviene revisarlo en el SGD.' }),
          listaUbicacion(r.ubicacionOrigen),
        ),
      );
    }
    cont.append(ficha);
    return;
  }

  if (r.matches.length === 0) {
    cont.append(el('p', { class: 'vacio', text: `No se encontró "${r.term}" en tus dependencias.` }));
    return;
  }

  // Sin ubicación calculada (búsqueda por texto): lista de documentos encontrados.
  const filas = el('tbody');
  for (const m of r.matches) {
    filas.append(
      el(
        'tr',
        {},
        el('td', { text: m.expediente || '' }),
        el('td', { text: [m.tipo, m.nroDocumento].filter(Boolean).join(' ') }),
        el('td', { text: limpiarEstado(m.estado) }),
        el('td', { text: m.sigla ?? m.dependencia }),
        el('td', { text: m.fecha }),
      ),
    );
  }
  const cabecera = el('tr', {}, ...['Expediente', 'Documento', 'Estado', 'Dependencia', 'Fecha'].map((t) => el('th', { scope: 'col', text: t })));
  cont.append(
    el('p', { class: 'resumen ficha', text: `${plural(r.matches.length, 'documento encontrado', 'documentos encontrados')} para "${r.term}"` }),
    el('div', { class: 'tabla-contenedor' }, el('table', { class: 'tabla' }, el('thead', {}, cabecera), filas)),
  );
}

$('form-buscar').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  ocultarAviso();
  const termino = $('buscar-termino').value.trim();
  if (!termino) {
    mostrarAviso({ message: 'Escribe un número de expediente' });
    return;
  }
  const boton = $('buscar-enviar');
  ocupado(boton, true, 'Buscando…');
  $('buscar-resultado').replaceChildren();
  $('buscar-progreso').hidden = false;
  $('buscar-progreso-texto').textContent = 'Iniciando búsqueda…';
  $('buscar-barra').removeAttribute('value');
  try {
    const { trabajo } = await api('POST', '/api/busqueda', { json: { termino } });
    const resultado = await esperarTrabajo(trabajo, (t) => {
      $('buscar-progreso-texto').textContent = textoProgreso(t, 'Buscando…');
      actualizarBarra($('buscar-barra'), t);
    });
    renderBusqueda(resultado);
  } catch (error) {
    await manejarError(error);
  } finally {
    $('buscar-progreso').hidden = true;
    ocupado(boton, false);
  }
});

// --- Varios (Excel) ---

let terminosLote = [];
let trabajoLote = null;

function mostrarPasoLote(paso) {
  $('lote-carga').hidden = paso !== 'carga' && paso !== 'previa';
  $('lote-previa').hidden = paso !== 'previa';
  $('lote-progreso').hidden = paso !== 'progreso';
  $('lote-resultado').hidden = paso !== 'resultado';
}

function limpiarConsulta() {
  terminosLote = [];
  trabajoLote = null;
  $('lote-archivo').value = '';
  $('lote-archivo-nombre').textContent = 'Ningún archivo elegido';
  $('buscar-resultado').replaceChildren();
  $('buscar-termino').value = '';
  mostrarPasoLote('carga');
}

$('lote-archivo').addEventListener('change', async () => {
  ocultarAviso();
  const archivo = $('lote-archivo').files[0];
  if (!archivo) return;
  $('lote-archivo-nombre').textContent = archivo.name;
  mostrarPasoLote('carga');
  try {
    const previa = await api('POST', '/api/lote/excel', { binario: await archivo.arrayBuffer() });
    terminosLote = previa.terminos;
    const repetidos =
      previa.duplicados > 0 ? ` (${plural(previa.duplicados, 'fila repetida se consulta', 'filas repetidas se consultan')} una sola vez)` : '';
    $('lote-previa-resumen').textContent = `${plural(previa.terminos.length, 'expediente distinto', 'expedientes distintos')} para consultar${repetidos}.`;
    $('lote-previa-lista').replaceChildren(...previa.terminos.map((t) => el('li', { text: t })));
    mostrarPasoLote('previa');
    $('lote-consultar').focus();
  } catch (error) {
    $('lote-archivo').value = '';
    $('lote-archivo-nombre').textContent = 'Ningún archivo elegido';
    await manejarError(error);
  }
});

$('lote-otro').addEventListener('click', () => {
  limpiarConsulta();
  $('lote-archivo').click();
});

$('lote-nuevo').addEventListener('click', () => limpiarConsulta());

function renderLote(resultados) {
  const ubicados = resultados.filter((r) => r.ubicacion).length;
  const difieren = resultados.filter((r) => r.difiere).length;
  const partes = [`${ubicados} de ${plural(resultados.length, 'expediente ubicado', 'expedientes ubicados')}`];
  if (difieren > 0) partes.push(`${difieren} para revisar`);
  $('lote-resumen').textContent = partes.join(' · ');

  const filas = resultados.map((r) => {
    const u = r.ubicacion;
    if (!u) {
      // Sin ubicación: un solo mensaje en lugar de columnas vacías.
      const motivo = r.error ? ` · ${mayuscula(r.error)}` : '';
      return el('tr', { class: 'sin-ubicacion' }, el('td', { text: r.term }), el('td', { colspan: '3', text: `No encontrado${motivo}` }), el('td'));
    }
    return el(
      'tr',
      r.difiere ? { class: 'difiere' } : {},
      el('td', { text: r.term }),
      el('td', { text: limpiarEstado(u.estado) }),
      el('td', { text: u.dependencia }),
      el('td', { class: 'documento', text: u.documento }),
      el('td', r.difiere ? { class: 'marca-revisar', text: 'Sí' } : {}),
    );
  });
  $('lote-filas').replaceChildren(...filas);
}

$('lote-consultar').addEventListener('click', async () => {
  ocultarAviso();
  const boton = $('lote-consultar');
  ocupado(boton, true);
  mostrarPasoLote('progreso');
  $('lote-progreso-texto').textContent = 'Iniciando consulta…';
  $('lote-barra').removeAttribute('value');
  try {
    const { trabajo } = await api('POST', '/api/lote', { json: { terminos: terminosLote } });
    trabajoLote = trabajo;
    const { resultados } = await esperarTrabajo(trabajo, (t) => {
      $('lote-progreso-texto').textContent = textoProgreso(t, 'Consultando…');
      actualizarBarra($('lote-barra'), t);
    });
    renderLote(resultados);
    mostrarPasoLote('resultado');
  } catch (error) {
    mostrarPasoLote('previa');
    await manejarError(error);
  } finally {
    ocupado(boton, false);
  }
});

$('lote-descargar').addEventListener('click', async () => {
  if (!trabajoLote) return;
  ocultarAviso();
  const boton = $('lote-descargar');
  ocupado(boton, true, 'Preparando…');
  try {
    const res = await fetch(`/api/trabajos/${trabajoLote}/excel`, { headers: { 'x-sgd-token': TOKEN } });
    if (!res.ok) throw new ApiError((await res.json().catch(() => ({}))).error);
    const nombre = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'ubicacion-expedientes.xlsx';
    const url = URL.createObjectURL(await res.blob());
    const enlace = el('a', { href: url, download: nombre });
    document.body.append(enlace);
    enlace.click();
    enlace.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (error) {
    await manejarError(error);
  } finally {
    ocupado(boton, false);
  }
});

// --- Inicio ---

refrescar().catch((error) => {
  $('cargando').hidden = true;
  mostrarAviso(error);
});
