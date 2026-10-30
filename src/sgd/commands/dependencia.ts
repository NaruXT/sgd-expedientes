// Cambio de dependencia activa. Un usuario puede tener acceso a varias
// dependencias (coDep distinto); el documento visible depende de cuál esté
// activa. Mecanismo (de default.js):
//   listar:  POST cambiaDep.do (body vacío) -> HTML con fu_activaDependencia(coDep, deDep)
//   cambiar: POST acceso.do con txtCoDep=<coDep> (form nativo; rota la cookie)
import { request, encodeForm, extractJsessionid } from '../lib/http.ts';
import { AppError } from '../lib/errors.ts';
import { looksLikeLoginPage } from '../auth.ts';
import type { Config, Session } from '../lib/config.ts';

export interface Dependencia {
  coDep: string;
  nombre: string;
  sigla: string | null;
}

// Lista las dependencias a las que el usuario tiene acceso.
export async function listDependencias(config: Config, session: Session): Promise<Dependencia[]> {
  const res = await request({
    method: 'POST',
    host: config.host,
    path: '/sgd/4.0/cambiaDep.do',
    cookie: session.jsessionid,
    body: '',
    ca: config.ca,
    xhr: true,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const html = res.body.toString('utf8').replace(/&quot;/g, '"');
  if (looksLikeLoginPage(html)) {
    throw new AppError('session_expired', 'la sesión del SGD expiró', {
      hint: 'vuelve a iniciar sesión para continuar',
    });
  }
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  const out: Dependencia[] = [];
  const seen = new Set<string>();
  for (const tr of rows) {
    const m = /fu_activaDependencia\w*\(\s*['"]?(\d+)['"]?\s*,\s*['"]([^'"]*)/.exec(tr);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const cells = (tr.match(/<td[\s\S]*?<\/td>/gi) ?? []).map((c) =>
      c.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
    );
    // La sigla suele ser la primera celda corta en mayúsculas.
    const sigla = cells.find((c) => /^[A-Z][A-Z-]{1,15}$/.test(c)) ?? null;
    out.push({ coDep: m[1], nombre: m[2].trim(), sigla });
  }
  return out;
}

// Fija la dependencia activa de la SESIÓN del servidor (form nativo acceso.do ->
// rota la cookie). El servidor filtra por la dependencia activa de la sesión, no
// por el coDep del body de cada conector, así que este cambio es el único que hace
// que los listados vean otra dependencia. Devuelve la cookie nueva y la dependencia
// destino resuelta; NO persiste nada (eso lo decide quien llama).
export async function activateDependencia(
  config: Config,
  session: Session,
  coDep: string,
): Promise<{ cookie: string; target: Dependencia }> {
  const deps = await listDependencias(config, session);
  const target = deps.find((d) => d.coDep === coDep);
  if (!target) {
    throw new AppError('usage', `la dependencia ${coDep} no está entre tus dependencias`);
  }

  let cookie: string | null = session.jsessionid;
  const bump = (r: { setCookie: string[] }): void => {
    const c = extractJsessionid(r.setCookie);
    if (c) cookie = c;
  };
  let res = await request({
    method: 'POST',
    host: config.host,
    path: '/sgd/acceso.do',
    cookie: cookie ?? undefined,
    body: encodeForm({ txtCoDep: coDep }),
    ca: config.ca,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${config.host}/sgd/login.do` },
  });
  bump(res);
  let guard = 0;
  while (res.status >= 300 && res.status < 400 && guard < 5) {
    const loc = res.headers['location'] as string | undefined;
    if (!loc) break;
    const rel = loc.replace(config.host, '');
    res = await request({
      method: 'GET',
      host: config.host,
      path: rel.startsWith('/') ? rel : `/sgd/${rel}`,
      cookie: cookie ?? undefined,
      ca: config.ca,
    });
    bump(res);
    guard++;
  }
  if (!cookie) throw new AppError('auth_failed', 'el cambio de dependencia no devolvió una cookie de sesión');
  return { cookie, target };
}

// Vuelve a `coDep` como dependencia activa y devuelve la cookie resultante. Lo usan
// las búsquedas que activan otras dependencias y deben dejar la del usuario al
// terminar. Lanza si falla; quien llama decide cómo avisar.
export async function restoreDependencia(config: Config, current: Session, coDep: string): Promise<string> {
  const { cookie } = await activateDependencia(config, current, coDep);
  return cookie;
}
