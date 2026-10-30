// Flujo de autenticación del SGD: login por formulario con credenciales en
// Base64 -> cookie JSESSIONID. Ver recon/report.md (sección Autenticación).
import { request, extractJsessionid, encodeForm } from './lib/http.ts';
import { AppError } from './lib/errors.ts';
import type { Config, Session } from './lib/config.ts';

// btoa(unescape(encodeURIComponent(v))): base64 de los bytes UTF-8 del valor.
function b64(v: string): string {
  return Buffer.from(v, 'utf8').toString('base64');
}

// Heurística: ¿el HTML es la página de login (no autenticado)?
export function looksLikeLoginPage(html: string): boolean {
  const h = html.toLowerCase();
  const hasPasswordInput = /id\s*=\s*["']depass["']/.test(h) || /name\s*=\s*["']depassword["']/.test(h);
  const hasUserInput = /id\s*=\s*["']cousuario["']/.test(h);
  return hasPasswordInput || hasUserInput;
}

export function mentionsCaptcha(html: string): boolean {
  return /jcaptcha|textocaptcha/i.test(html);
}

// Detecta el código de dependencia (coDep) del HTML de la home autenticada.
// Tolerante: prueba varias formas (input oculto, global JS).
export function detectCoDep(html: string): string | null {
  const patterns = [
    /name\s*=\s*["']co?Dep(?:endencia)?["']\s+value\s*=\s*["'](\d+)["']/i,
    /\bco?Dep(?:endencia)?\s*[:=]\s*["']?(\d{3,})["']?/i,
    /goSeleccionaDep[^0-9]{0,40}(\d{4,})/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) return m[1];
  }
  return null;
}

export function detectDepName(html: string): string | null {
  const patterns = [
    /name\s*=\s*["']deDependencia["']\s+value\s*=\s*["']([^"']+)["']/i,
    /\bdeDependencia\s*[:=]\s*["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) return m[1].trim();
  }
  return null;
}

export interface DepAcceso {
  coDep: string | null;
  deDep: string | null;
  cempCodemp: string | null;
  nroIntento: number;
  userExists: boolean;
}

// Pre-auth: resuelve la dependencia del usuario y los contadores de intentos.
// El navegador lo dispara al tipear el usuario; login.do parece depender de que
// esta llamada haya poblado la dependencia en la sesión. Body plano (el servidor
// no exige la ofuscación AES), param `pcoUsuario`. Respuesta = JSON estricto.
export async function resolveDependencia(
  config: Config,
  jsid: string | null,
  user: string,
): Promise<DepAcceso> {
  const res = await request({
    method: 'POST',
    host: config.host,
    path: '/sgd/4.0/srDepAcceso.do?accion=goSeleccionaDep',
    cookie: jsid ?? undefined,
    body: encodeForm({ accion: 'goSeleccionaDep', pcoUsuario: user }),
    ca: config.ca,
    xhr: true,
  });
  const text = res.body.toString('utf8').trim();
  if (text.length === 0) {
    return { coDep: null, deDep: null, cempCodemp: null, nroIntento: 0, userExists: false };
  }
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    return {
      coDep: (j.coDep as string) ?? null,
      deDep: (j.deDep as string) ?? null,
      cempCodemp: (j.cempCodemp as string) ?? null,
      nroIntento: typeof j.nroIntento === 'number' ? j.nroIntento : Number(j.nroIntento) || 0,
      userExists: true,
    };
  } catch {
    return { coDep: null, deDep: null, cempCodemp: null, nroIntento: 0, userExists: true };
  }
}

export interface LoginResult {
  session: Session;
  homeHtml: string;
}

export async function performLogin(
  config: Config,
  user: string,
  password: string,
): Promise<LoginResult> {
  const host = config.host;
  const ca = config.ca;

  // El servidor rota JSESSIONID en casi cada respuesta (anti session-fixation).
  // Hay que propagar la cookie MÁS RECIENTE en cada paso: si el POST usa una
  // cookie vieja cae en otra sesión sin el modelo del form -> 500
  // HttpSessionRequiredException (ambas cosas verificadas en vivo).
  let cookie: string | null = null;
  const bump = (r: { setCookie: string[] }): void => {
    const c = extractJsessionid(r.setCookie);
    if (c) cookie = c;
  };

  // 1. Bootstrap (fija la primera cookie).
  bump(await request({ method: 'GET', host, path: '/sgd/login.do', ca }));

  // 2. Renderiza el formulario (GET 200). IMPRESCINDIBLE: crea en la sesión el
  //    modelo que el controller del POST exige; sin esto el POST da 500.
  bump(await request({ method: 'GET', host, path: '/sgd/login.do', cookie: cookie ?? undefined, ca }));

  // 3. POST de credenciales (form nativo, sin X-Requested-With). El navegador
  //    (login() en default.js) manda:
  //      coUsuario  = base64(UPPERCASE(usuario))  <- fu_getTextUpperCase
  //      dePassword = base64(password tal cual)    <- fu_getTextCadenaLogin
  //    La recon afirmaba base64 pero omitía el uppercase del usuario (verificado
  //    contra default.js): esa omisión era una de las causas del login rechazado.
  const body = encodeForm({
    coUsuario: b64(user.toUpperCase()),
    dePassword: b64(password),
    textoCaptcha: '',
  });
  const post = await request({
    method: 'POST',
    host,
    path: '/sgd/login.do',
    cookie: cookie ?? undefined,
    body,
    ca,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Origin: host,
      Referer: `${host}/sgd/login.do`,
    },
  });
  bump(post);

  // 4. Sigue la cadena de redirects (patrón PRG) propagando la cookie, hasta la
  //    página final: un login OK termina en la home; uno fallido, en el form.
  let res = post;
  let guard = 0;
  while (res.status >= 300 && res.status < 400 && guard < 5) {
    const loc = res.headers['location'] as string | undefined;
    if (!loc) break;
    const rel = loc.replace(host, '');
    res = await request({
      method: 'GET',
      host,
      path: rel.startsWith('/') ? rel : `/sgd/${rel}`,
      cookie: cookie ?? undefined,
      ca,
    });
    bump(res);
    guard++;
  }
  if (!cookie) {
    throw new AppError('auth_failed', 'el servidor no devolvió una cookie de sesión');
  }

  // 5. Verifica: si la página final sigue siendo el formulario de login, falló.
  const homeHtml = res.body.toString('utf8');
  if (looksLikeLoginPage(homeHtml)) {
    const captchaHint = mentionsCaptcha(homeHtml)
      ? '; el login muestra captcha (varios intentos fallidos): entra una vez por el navegador del SGD para limpiarlo'
      : '';
    throw new AppError('auth_failed', 'usuario o contraseña incorrectos', {
      hint: `verifica tus datos del SGD${captchaHint}`,
    });
  }

  return {
    session: { jsessionid: cookie, user, createdAt: new Date().toISOString() },
    homeHtml,
  };
}
