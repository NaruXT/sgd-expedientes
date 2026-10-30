// Configuración, rutas y notificador. Todo con directorios temporales: no toca la
// carpeta real de datos del usuario.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appDataDir, configPath } from '../src/sgd/lib/paths.ts';
import { EMPTY_CONFIG, loadConfig, saveConfig } from '../src/sgd/lib/config.ts';
import { silentNotifier } from '../src/sgd/lib/io.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sgd-exp-test-'));
}

describe('appDataDir', () => {
  test('Windows usa APPDATA', () => {
    expect(appDataDir({ APPDATA: 'C:\\Users\\ana\\AppData\\Roaming' }, 'win32', 'C:\\Users\\ana')).toBe(
      join('C:\\Users\\ana\\AppData\\Roaming', 'sgd-expedientes'),
    );
  });

  test('Windows sin APPDATA cae a AppData\\Roaming del home', () => {
    expect(appDataDir({}, 'win32', '/home/x')).toBe(join('/home/x', 'AppData', 'Roaming', 'sgd-expedientes'));
  });

  test('macOS usa Application Support', () => {
    expect(appDataDir({}, 'darwin', '/Users/ana')).toBe(
      join('/Users/ana', 'Library', 'Application Support', 'sgd-expedientes'),
    );
  });

  test('Linux respeta XDG_CONFIG_HOME y, si no existe, usa ~/.config', () => {
    expect(appDataDir({ XDG_CONFIG_HOME: '/xdg' }, 'linux', '/home/x')).toBe(join('/xdg', 'sgd-expedientes'));
    expect(appDataDir({}, 'linux', '/home/x')).toBe(join('/home/x', '.config', 'sgd-expedientes'));
  });

  test('configPath cae dentro de la carpeta dada', () => {
    expect(configPath('/tmp/d')).toBe(join('/tmp/d', 'config.json'));
  });
});

describe('config', () => {
  test('sin archivo, devuelve la configuración vacía con host vacío', () => {
    const dir = tempDir();
    try {
      expect(loadConfig(dir)).toEqual(EMPTY_CONFIG);
      expect(loadConfig(dir).host).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('guarda y vuelve a leer host, certificado y dependencia', () => {
    const dir = tempDir();
    try {
      saveConfig({ host: 'https://sgd.ejemplo.gob.pe:8181', ca: '-----BEGIN CERTIFICATE-----', coDep: '123', depName: 'OFICINA' }, dir);
      expect(loadConfig(dir)).toEqual({
        host: 'https://sgd.ejemplo.gob.pe:8181',
        ca: '-----BEGIN CERTIFICATE-----',
        coDep: '123',
        depName: 'OFICINA',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('un archivo dañado no rompe la app: devuelve la configuración vacía', async () => {
    const dir = tempDir();
    try {
      saveConfig({ host: 'https://x' }, dir);
      await Bun.write(configPath(dir), '{no es json');
      expect(loadConfig(dir)).toEqual(EMPTY_CONFIG);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('en posix, el archivo de configuración se guarda con permisos 0600', () => {
    if (process.platform === 'win32') return;
    const dir = tempDir();
    try {
      saveConfig({ host: 'https://x' }, dir);
      const mode = statSync(configPath(dir)).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('notificador silencioso', () => {
  test('acepta progreso y avisos sin efectos', () => {
    expect(() => {
      silentNotifier.progress({ fase: 'búsqueda', hechos: 1, total: 2 });
      silentNotifier.note('aviso');
    }).not.toThrow();
  });
});
