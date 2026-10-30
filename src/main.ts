// Punto de entrada: servidor HTTP local, solo accesible desde este equipo, y apertura
// del navegador en la interfaz.
import { startServer } from './server/server.ts';
import type { RunningServer } from './server/server.ts';

const PUERTO = Number(process.env.SGD_PORT ?? 8765);
const ABRIR = process.env.SGD_NO_ABRIR !== '1';

function abrirNavegador(url: string): void {
  // Se pasan los argumentos como lista (sin shell): la URL no se interpreta.
  const comando =
    process.platform === 'win32'
      ? ['rundll32', 'url.dll,FileProtocolHandler', url]
      : process.platform === 'darwin'
        ? ['open', url]
        : ['xdg-open', url];
  try {
    Bun.spawn(comando, { stdout: 'ignore', stderr: 'ignore' });
  } catch {
    console.log(`Abre esta dirección en tu navegador: ${url}`);
  }
}

let server: RunningServer;
try {
  server = startServer({ port: PUERTO });
} catch (e) {
  // El puerto ocupado casi siempre es otra ventana de la app ya abierta: se muestra esa.
  if ((e as { code?: string }).code === 'EADDRINUSE') {
    const url = `http://127.0.0.1:${PUERTO}/`;
    console.log(`SGD Expedientes ya está abierto en ${url}`);
    if (ABRIR) abrirNavegador(url);
    process.exit(0);
  }
  throw e;
}

console.log(`SGD Expedientes en ${server.url}`);
console.log('Deja esta ventana abierta mientras uses la aplicación.');
if (ABRIR) abrirNavegador(server.url);
