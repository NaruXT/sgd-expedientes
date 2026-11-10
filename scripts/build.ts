// Compila los ejecutables de distribución con `bun build --compile` y escribe sus
// SHA-256 en dist/<versión>/SHA256SUMS.txt (formato compatible con `shasum -c`).
//
// Uso:
//   bun run build                  todos los objetivos
//   bun run build windows-x64      solo los objetivos indicados
//
// Los ejecutables de macOS se compilan en macOS: Bun anexa la app al runtime y eso
// invalida la firma del runtime, así que se vuelven a firmar ad-hoc con `codesign`.
// Sin esa firma válida, al descargarlos macOS los muestra como "dañados" y no deja
// abrirlos. Windows se puede compilar desde cualquier sistema.
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import paquete from '../package.json' with { type: 'json' };

export interface Objetivo {
  nombre: string; // nombre corto que se usa en la línea de comandos y en el archivo
  bunTarget: string; // valor de --target de bun build
  extension: string;
  macos: boolean; // requiere compilar en macOS y re-firmar ad-hoc
}

export const OBJETIVOS: Objetivo[] = [
  // baseline: corre también en procesadores sin AVX2 (equipos institucionales antiguos).
  { nombre: 'windows-x64', bunTarget: 'bun-windows-x64-baseline', extension: '.exe', macos: false },
  { nombre: 'macos-arm64', bunTarget: 'bun-darwin-arm64', extension: '', macos: true },
  { nombre: 'macos-x64', bunTarget: 'bun-darwin-x64', extension: '', macos: true },
];

export function nombreArchivo(version: string, objetivo: Objetivo): string {
  return `sgd-expedientes-${version}-${objetivo.nombre}${objetivo.extension}`;
}

// Sin argumentos, todos los objetivos. Con argumentos, solo esos, en el orden de OBJETIVOS.
export function elegirObjetivos(args: string[]): Objetivo[] {
  if (args.length === 0) return OBJETIVOS;
  const desconocidos = args.filter((a) => !OBJETIVOS.some((o) => o.nombre === a));
  if (desconocidos.length > 0) {
    const opciones = OBJETIVOS.map((o) => o.nombre).join(', ');
    throw new Error(`objetivo desconocido: ${desconocidos.join(', ')}. Opciones: ${opciones}`);
  }
  return OBJETIVOS.filter((o) => args.includes(o.nombre));
}

export function lineaSha256(hash: string, archivo: string): string {
  return `${hash}  ${archivo}`;
}

const RAIZ = resolve(import.meta.dir, '..');

// Ejecuta un comando con sus argumentos como lista (sin shell).
async function ejecutar(comando: string[]): Promise<void> {
  const proceso = Bun.spawn(comando, { cwd: RAIZ, stdout: 'inherit', stderr: 'inherit' });
  const codigo = await proceso.exited;
  if (codigo !== 0) throw new Error(`${basename(comando[0])} terminó con código ${codigo}`);
}

// Compila con el mismo Bun que corre el script.
function compilar(objetivo: Objetivo, salida: string): Promise<void> {
  return ejecutar([process.execPath, 'build', '--compile', '--minify', `--target=${objetivo.bunTarget}`, 'src/main.ts', '--outfile', salida]);
}

// Reemplaza la firma invalidada del runtime por una firma ad-hoc y la verifica.
async function firmarAdhoc(ruta: string): Promise<void> {
  await ejecutar(['codesign', '--force', '--sign', '-', ruta]);
  await ejecutar(['codesign', '--verify', '--strict', ruta]);
}

// Falla antes de compilar si se piden objetivos de macOS fuera de macOS.
export function verificarPlataforma(objetivos: Objetivo[], plataforma: string): void {
  const mac = objetivos.filter((o) => o.macos).map((o) => o.nombre);
  if (mac.length > 0 && plataforma !== 'darwin') {
    throw new Error(`${mac.join(', ')} se compila en macOS (necesita codesign); en este sistema compila solo windows-x64`);
  }
}

async function sha256(ruta: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(await Bun.file(ruta).arrayBuffer());
  return hasher.digest('hex');
}

// bun build --compile deja temporales `*.bun-build` en la carpeta de trabajo.
function limpiarTemporales(): void {
  for (const archivo of readdirSync(RAIZ)) {
    if (archivo.endsWith('.bun-build')) rmSync(join(RAIZ, archivo), { force: true });
  }
}

async function main(): Promise<void> {
  const objetivos = elegirObjetivos(process.argv.slice(2));
  verificarPlataforma(objetivos, process.platform);
  const version = paquete.version;
  const destino = join(RAIZ, 'dist', version);
  rmSync(destino, { recursive: true, force: true });
  mkdirSync(destino, { recursive: true });

  const lineas: string[] = [];
  try {
    for (const objetivo of objetivos) {
      const salida = join(destino, nombreArchivo(version, objetivo));
      console.log(`\n» ${objetivo.nombre} (${objetivo.bunTarget})`);
      await compilar(objetivo, salida);
      if (objetivo.macos) await firmarAdhoc(salida);
      lineas.push(lineaSha256(await sha256(salida), basename(salida)));
    }
  } finally {
    limpiarTemporales();
  }

  await Bun.write(join(destino, 'SHA256SUMS.txt'), lineas.join('\n') + '\n');

  console.log(`\nVersión ${version} en ${destino}`);
  for (const linea of lineas) {
    const [hash, archivo] = linea.split('  ');
    const mb = (statSync(join(destino, archivo)).size / 1024 / 1024).toFixed(1);
    console.log(`  ${archivo.padEnd(42)} ${mb.padStart(6)} MB  ${hash}`);
  }
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
