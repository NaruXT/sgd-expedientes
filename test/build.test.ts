// Partes puras del script de compilación: elección de objetivos y nombres de archivo.
import { describe, expect, test } from 'bun:test';
import { OBJETIVOS, elegirObjetivos, lineaSha256, nombreArchivo, verificarPlataforma } from '../scripts/build.ts';

describe('script de compilación', () => {
  test('sin argumentos compila todos los objetivos', () => {
    expect(elegirObjetivos([]).map((o) => o.nombre)).toEqual(['windows-x64', 'macos-arm64', 'macos-x64']);
  });

  test('con argumentos compila solo esos, en el orden fijo', () => {
    expect(elegirObjetivos(['macos-x64', 'windows-x64']).map((o) => o.nombre)).toEqual(['windows-x64', 'macos-x64']);
  });

  test('un objetivo desconocido falla y lista las opciones', () => {
    expect(() => elegirObjetivos(['linux'])).toThrow(/objetivo desconocido: linux\. Opciones: windows-x64, macos-arm64, macos-x64/);
  });

  test('Windows usa la variante baseline, compatible con procesadores sin AVX2', () => {
    expect(OBJETIVOS.find((o) => o.nombre === 'windows-x64')?.bunTarget).toBe('bun-windows-x64-baseline');
  });

  test('el nombre del archivo lleva la versión y la plataforma', () => {
    const [windows, mac] = OBJETIVOS;
    expect(nombreArchivo('0.1.0', windows)).toBe('sgd-expedientes-0.1.0-windows-x64.exe');
    expect(nombreArchivo('0.1.0', mac)).toBe('sgd-expedientes-0.1.0-macos-arm64');
  });

  test('las sumas usan el formato de shasum: hash, dos espacios y archivo', () => {
    expect(lineaSha256('abc123', 'app.exe')).toBe('abc123  app.exe');
  });

  test('los objetivos de macOS solo se compilan en macOS (necesitan codesign)', () => {
    expect(() => verificarPlataforma(OBJETIVOS, 'darwin')).not.toThrow();
    expect(() => verificarPlataforma(elegirObjetivos(['windows-x64']), 'linux')).not.toThrow();
    expect(() => verificarPlataforma(elegirObjetivos(['windows-x64']), 'win32')).not.toThrow();
    expect(() => verificarPlataforma(OBJETIVOS, 'linux')).toThrow(/macos-arm64, macos-x64 se compila en macOS/);
  });
});
