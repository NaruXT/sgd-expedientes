// Archivos de la interfaz incrustados en el binario como texto: el ejecutable no
// necesita archivos al lado para funcionar.
import indexHtml from '../ui/index.html' with { type: 'text' };
import appJs from '../ui/app.js' with { type: 'text' };
import stylesCss from '../ui/styles.css' with { type: 'text' };
import faviconSvg from '../ui/favicon.svg' with { type: 'text' };

// Cabeceras de seguridad para todo lo que sirve el servidor local. La CSP no permite
// scripts inline ni recursos externos: la página solo carga /app.js y /styles.css.
export const CABECERAS_SEGURIDAD: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob: data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
};

// El token viaja en una etiqueta <meta>, no en un script inline, para mantener la CSP
// estricta. Es hexadecimal, así que no necesita escaparse. Los tipos de Bun declaran
// los .html como HTMLBundle; con `type: 'text'` el valor real es el texto del archivo.
export function paginaPrincipal(token: string): string {
  return (indexHtml as unknown as string).replace('__SGD_TOKEN__', token);
}

export const ESTATICOS: Record<string, { contenido: string; tipo: string }> = {
  '/app.js': { contenido: appJs, tipo: 'text/javascript; charset=utf-8' },
  '/styles.css': { contenido: stylesCss, tipo: 'text/css; charset=utf-8' },
  '/favicon.svg': { contenido: faviconSvg, tipo: 'image/svg+xml' },
};
