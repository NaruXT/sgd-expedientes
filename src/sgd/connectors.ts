// Definición data-driven de los 7 conectores de lectura verificados en la recon
// (recon/connectors.md). Cada cuerpo se transcribe fiel, con placeholders que se
// resuelven en tiempo de llamada desde la sesión/config y los filtros del usuario.
//
// Placeholders: {coDep} {depName} {feIni} {feFin} {year}
//
// El naming de campos difiere por conector (prefijo s / bus,co / otra convención
// en VoBo), por eso cada uno lleva su propio mapa filtro->campo. Además de los
// filtros nombrados, todo comando acepta --set campo=valor para fijar cualquier
// campo del body directamente (escape hatch ante la falta de contrato).

export interface ConnectorFilters {
  desde?: string; // dd/mm/yyyy
  hasta?: string; // dd/mm/yyyy
  estado?: string; // texto a matchear (substring, case-insensitive) en la columna ESTADO; filtro client-side
  prioridad?: string; // muy-urgente|urgente|normal -> sPrioridadDoc; server-side (verificado en vivo)
  asunto?: string;
  expediente?: string;
  nroDocumento?: string;
  remitente?: string;
  destinatario?: string;
  set?: Record<string, string>; // passthrough directo campo->valor
}

// Códigos de prioridad (sPrioridadDoc), verificados en vivo contra la bandeja de
// recepción: 1=MUY URGENTE (30 docs), 2=URGENTE (13), 3=NORMAL (30), suman los 73
// "pendientes de recibir". El filtro lo resuelve el servidor (no es client-side).
export const PRIORIDAD_CODES: Record<string, string> = {
  'muy-urgente': '1',
  urgente: '2',
  normal: '3',
};

export interface ConnectorContext {
  coDep: string;
  depName: string;
  year: string;
}

export interface Connector {
  key: string; // identidad noun-verb, ej. "recepcion listar"
  endpoint: string; // ej. srDocumentoAdmRecepcion.do
  needsCoDep: boolean;
  // Estado: en RECEPCIÓN/CONSULTA el servidor ignora el filtro de estado, así que
  // --estado se aplica client-side (substring sobre la columna ESTADO). En EMISIÓN
  // el estado SÍ filtra server-side vía sEstadoDoc; estadoServer mapea el nombre
  // amigable al código (verificado en vivo). Cuando estadoServer resuelve el
  // filtro, el comando NO vuelve a filtrar client-side.
  estadoServer?: Record<string, string>;
  // Campo del body para la prioridad (server-side). Solo se setea en los conectores
  // donde se verificó que el servidor lo honra. Undefined = --prioridad no aplica.
  prioridadField?: string;
  dateFields: { ini: string; fin: string }; // campos de rango de fecha
  // Mapa filtro-cli -> campo-body para los filtros de texto comunes.
  filterFields: Partial<Record<keyof ConnectorFilters, string>>;
  // Construye el body base (con placeholders ya resueltos) para esta llamada.
  body: (ctx: ConnectorContext, dateMode: '1' | '2', feIni: string, feFin: string) => Record<string, string>;
}

// ---- 1. Recepción (bandeja de entrada) ----
const recepcion: Connector = {
  key: 'recepcion listar',
  endpoint: 'srDocumentoAdmRecepcion.do',
  needsCoDep: false,
  prioridadField: 'sPrioridadDoc', // verificado: 1/2/3 filtran server-side
  dateFields: { ini: 'sFeEmiIni', fin: 'sFeEmiFin' },
  filterFields: {
    asunto: 'sBuscAsunto',
    expediente: 'sBuscNroExpediente',
    nroDocumento: 'sNroDocumento',
    destinatario: 'sBuscDestinatario',
    remitente: 'sRemitente',
  },
  body: (ctx, dateMode, feIni, feFin) => ({
    sTipoBusqueda: '0',
    esFiltroFecha: dateMode,
    sFeEmiIni: feIni,
    sFeEmiFin: feFin,
    sBandejaEntrada: '1',
    sNroDocumento: '',
    sNroExtDocumento: '',
    sBuscNroExpediente: '',
    sBuscAsunto: '',
    _esIncluyeOtrosResultados: 'on',
    _esIncluyeFiltro: 'on',
    sBuscDestinatario: '',
    txtDepEmiteBus: '+[TODOS]',
    sDeTipoDocAdm: '',
    sNumDocRef: '',
    sCoAnnioBus: ctx.year,
    sCoAnnio: ctx.year,
    sEstadoDoc: '0',
    sPrioridadDoc: '',
    sTipoDoc: '',
    sRemitente: '',
    txtRemitente: '[TODOS]',
    sDestinatario: '',
    txtDestinatario: '[TODOS]',
    idEtiqueta: '',
  }),
};

// ---- 2. Emisión (bandeja de salida) ----
const emision: Connector = {
  key: 'emision listar',
  endpoint: 'srDocumentoAdmEmision.do',
  needsCoDep: true,
  // Códigos de sEstadoDoc de emisión (verificados en vivo).
  estadoServer: {
    'recibido-parcial': '1',
    recibido: '2',
    atendido: '3',
    archivado: '4',
    'en-proyecto': '5',
    'atendido-parcial': '6',
    'para-despacho': '7',
    anulado: '9',
  },
  dateFields: { ini: 'sFeEmiIni', fin: 'sFeEmiFin' },
  filterFields: {
    asunto: 'sDeAsuM',
    expediente: 'sBuscNroExpediente',
    nroDocumento: 'sNumDoc',
    destinatario: 'sBuscDestinatario',
  },
  body: (ctx, dateMode, feIni, feFin) => ({
    sTipoBusqueda: '0',
    sCoDependencia: ctx.coDep,
    sCoEmpleado: '',
    sTiAcceso: '',
    esFiltroFecha: dateMode,
    sFeEmiIni: feIni,
    sFeEmiFin: feFin,
    sBandejaEntrada: '1',
    sNumCorEmision: '',
    sNumDoc: '',
    sBuscNroExpediente: '',
    sDeAsuM: '',
    _esIncluyeOtrosResultados: 'on',
    _esIncluyeFiltro: 'on',
    sBuscDestinatario: '',
    txtDepEmiteBus: '+[TODOS]',
    sDeTipoDocAdm: '',
    sNumDocRef: '',
    sCoAnnioBus: ctx.year,
    sCoAnnio: ctx.year,
    sEstadoDoc: '5',
    sPrioridadDoc: '',
    sTipoDoc: '',
    txtRefOrigen: '[TODOS]',
    sRefOrigen: '',
    sDestinatario: '',
    txtDestinatario: '[TODOS]',
    sElaboradoPor: '',
    txtElaboradoPor: '[TODOS]',
  }),
};

// ---- 3. Seguimiento de emisión ----
const seguiEmi: Connector = {
  key: 'seguimiento emitidos',
  endpoint: 'srSeguiEstEmi.do',
  needsCoDep: true,
  dateFields: { ini: 'feEmiIni', fin: 'feEmiFin' },
  filterFields: {
    asunto: 'busAsunto',
    expediente: 'busNumExpediente',
    nroDocumento: 'busNumDoc',
  },
  body: (ctx, dateMode, feIni, feFin) => ({
    deDependencia: ctx.depName,
    coDependencia: ctx.coDep,
    tipoBusqueda: '0',
    esFiltroFecha: dateMode,
    feEmiIni: feIni,
    feEmiFin: feFin,
    esFiltroReferencia: '',
    busNumDoc: '',
    busNumExpediente: '',
    busAsunto: '',
    _esIncluyeOtrosResultados: 'on',
    _esIncluyeFiltro: 'on',
    busCodDepEmiRef: '',
    txtDepEmiteBus: '+[TODOS]',
    busCodTipoDocRef: '',
    busNumDocRef: '',
    busCoAnnio: ctx.year,
    coAnnio: ctx.year,
    estadoDoc: '',
    coVencimiento: '3',
    coTipoDocAdm: '',
    txtRefOrigen: '[TODOS]',
    coRefOrigen: '',
    coDepOrigen: ctx.coDep,
    txtDepOrigen: ctx.depName,
    coEmpElaboro: '',
    txtElaboradoPor: '[TODOS]',
    coDepDestino: '',
    txtDestinatario: '[TODOS]',
    coEmpDestino: '',
    txtEmpDestino: '[TODOS]',
  }),
};

// ---- 4. Consulta de emisión ----
const consultaEmi: Connector = {
  key: 'consulta emitidos',
  endpoint: 'srConsultaEmisionDoc.do',
  needsCoDep: true,
  dateFields: { ini: 'feEmiIni', fin: 'feEmiFin' },
  filterFields: {
    asunto: 'busAsunto',
    expediente: 'busNumExpediente',
    nroDocumento: 'busNumDoc',
  },
  body: (ctx, dateMode, feIni, feFin) => ({
    deDependencia: ctx.depName,
    tipoBusqueda: '0',
    coDependencia: ctx.coDep,
    coEmpleado: '',
    tiAcceso: '',
    esFiltroFecha: dateMode,
    feEmiIni: feIni,
    feEmiFin: feFin,
    esFiltroReferencia: '',
    busNumEmision: '',
    busNumDoc: '',
    busNumExpediente: '',
    busAsunto: '',
    _esIncluyeOtrosResultados: 'on',
    _esIncluyeFiltro: 'on',
    busCodDepEmiRef: '',
    txtDepEmiteBus: '+[TODOS]',
    busCodTipoDocRef: '',
    busNumDocRef: '',
    busCoAnnio: ctx.year,
    coAnnio: ctx.year,
    estadoDoc: '',
    prioridadDoc: '',
    tipoDoc: '',
    txtRefOrigen: '[TODOS]',
    coRefOrigen: '',
    coDepOrigen: ctx.coDep,
    txtDepOrigen: ctx.depName,
    coEmpElaboro: '',
    txtElaboradoPor: '[TODOS]',
    coDepDestino: '',
    txtDestinatario: '[TODOS]',
    coEmpDestino: '',
    txtEmpDestino: '[TODOS]',
  }),
};

// ---- 5. Consulta de recepción ----
const consultaRecep: Connector = {
  key: 'consulta recibidos',
  endpoint: 'srConsultaRecepcionDoc.do',
  needsCoDep: true,
  dateFields: { ini: 'feEmiIni', fin: 'feEmiFin' },
  filterFields: {
    asunto: 'busAsunto',
    expediente: 'busNumExpediente',
    nroDocumento: 'busNumDoc',
    remitente: 'coDepRemite',
  },
  body: (ctx, dateMode, feIni, feFin) => ({
    deDependencia: ctx.depName,
    coDependencia: ctx.coDep,
    tipoBusqueda: '0',
    esFiltroFecha: dateMode,
    feEmiIni: feIni,
    feEmiFin: feFin,
    esFiltroReferencia: '',
    busNumDoc: '',
    busNumExpediente: '',
    busAsunto: '',
    _esIncluyeOtrosResultados: 'on',
    _esIncluyeFiltro: 'on',
    busCodDepEmiRef: '',
    txtDepEmiteBus: '+[TODOS]',
    busCodTipoDocRef: '',
    busNumDocRef: '',
    busCoAnnio: ctx.year,
    coAnnio: ctx.year,
    estadoDoc: '',
    prioridadDoc: '',
    coTipoDocAdm: '',
    coDepDestino: ctx.coDep,
    txtDestinatario: ctx.depName,
    coEmpDestino: '',
    txtEmpDestino: '[TODOS]',
    coDepRemite: '',
    txtRemitente: '[TODOS]',
    idEtiqueta: '',
  }),
};

// ---- 6. Consulta de VoBo (visto bueno) ----
const consultaVobo: Connector = {
  key: 'consulta vobo',
  endpoint: 'srConsultaDocVobo.do',
  needsCoDep: false,
  dateFields: { ini: 'feIni', fin: 'feFin' },
  filterFields: {
    asunto: 'asunto',
    expediente: 'nroExp',
    nroDocumento: 'nuDoc',
  },
  body: (ctx, _dateMode, feIni, feFin) => ({
    tipBusqueda: '0',
    feIni: feIni,
    feFin: feFin,
    nuCorEmi: '',
    nuDoc: '',
    nroExp: '',
    asunto: '',
    _esIncluyeFiltro: 'on',
    nuAnn: ctx.year,
    esDoc: '',
    coPrioridadDoc: '',
    tipDoc: '',
    txtRefOrigen: '[TODOS]',
    coRefOri: '',
    coEmpElabora: '',
    txtElaboradoPor: '[TODOS]',
  }),
};

// ---- 7. Seguimiento de recepción ----
const seguiRecep: Connector = {
  key: 'seguimiento recibidos',
  endpoint: 'srSeguiEstRecep.do',
  needsCoDep: true,
  dateFields: { ini: 'feEmiIni', fin: 'feEmiFin' },
  filterFields: {
    asunto: 'busAsunto',
    expediente: 'busNumExpediente',
    nroDocumento: 'busNumDoc',
    remitente: 'coDepRemite',
  },
  body: (ctx, dateMode, feIni, feFin) => ({
    deDependencia: ctx.depName,
    coDependencia: ctx.coDep,
    tipoBusqueda: '0',
    esFiltroFecha: dateMode,
    feEmiIni: feIni,
    feEmiFin: feFin,
    esFiltroReferencia: '',
    busNumDoc: '',
    busNumExpediente: '',
    busAsunto: '',
    _esIncluyeOtrosResultados: 'on',
    _esIncluyeFiltro: 'on',
    busCodDepEmiRef: '',
    txtDepEmiteBus: '+[TODOS]',
    busCodTipoDocRef: '',
    busNumDocRef: '',
    busCoAnnio: ctx.year,
    coAnnio: ctx.year,
    estadoDoc: '',
    coVencimiento: '3',
    coTipoDocAdm: '',
    coDepDestino: ctx.coDep,
    txtDestinatario: ctx.depName,
    coEmpDestino: '',
    txtEmpDestino: '[TODOS]',
    coDepRemite: '',
    txtRemitente: '[TODOS]',
    idEtiqueta: '',
    prioridadDoc: '',
  }),
};

export const CONNECTORS: Record<string, Connector> = {
  'recepcion listar': recepcion,
  'emision listar': emision,
  'seguimiento emitidos': seguiEmi,
  'consulta emitidos': consultaEmi,
  'consulta recibidos': consultaRecep,
  'consulta vobo': consultaVobo,
  'seguimiento recibidos': seguiRecep,
};

// Construye el body final aplicando contexto + filtros.
export function buildBody(
  conn: Connector,
  ctx: ConnectorContext,
  filters: ConnectorFilters,
): Record<string, string> {
  const hasExplicitRange = Boolean(filters.desde || filters.hasta);
  const dateMode: '1' | '2' = hasExplicitRange ? '2' : '1';
  const { feIni, feFin } = defaultDateRange(ctx.year, filters);
  const body = conn.body(ctx, dateMode, feIni, feFin);

  // Estado server-side (emisión): mapea el nombre amigable a sEstadoDoc. El resto
  // de los filtros de texto NO se envían al body: verificado en vivo que este SGD
  // los IGNORA (--expediente devolvía el total completo). Se aplican client-side
  // sobre las columnas parseadas (ver commands/list.ts). filterFields queda como
  // referencia del nombre de campo. --set fuerza cualquier campo crudo.
  if (filters.estado && conn.estadoServer) {
    const code = conn.estadoServer[filters.estado];
    if (code != null) body['sEstadoDoc'] = code;
  }
  // Prioridad server-side: solo en conectores con prioridadField verificado.
  if (filters.prioridad && conn.prioridadField) {
    const code = PRIORIDAD_CODES[filters.prioridad];
    if (code != null) body[conn.prioridadField] = code;
  }
  if (filters.set) {
    for (const [k, v] of Object.entries(filters.set)) body[k] = v;
  }

  return body;
}

// ¿El filtro de estado ya lo resolvió el servidor (emisión)? Si sí, el comando
// no debe volver a filtrarlo client-side (los códigos server-side no matchean por
// substring con las etiquetas visibles, ej. '7' vs 'PARA DESPACHO').
export function estadoIsServerSide(conn: Connector, estado: string | undefined): boolean {
  return Boolean(estado && conn.estadoServer && conn.estadoServer[estado] != null);
}

function defaultDateRange(
  year: string,
  filters: ConnectorFilters,
): { feIni: string; feFin: string } {
  if (filters.desde || filters.hasta) {
    return {
      feIni: filters.desde ?? `01/01/${year}`,
      feFin: filters.hasta ?? `31/12/${year}`,
    };
  }
  // Modo 1 (últimos ~30 días): el servidor acota por su cuenta; damos un rango
  // amplio del año para que la fila de fechas nunca quede vacía.
  return { feIni: `01/01/${year}`, feFin: `31/12/${year}` };
}
