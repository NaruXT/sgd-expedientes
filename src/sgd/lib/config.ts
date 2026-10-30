// Configuración persistida. Solo identificadores y datos públicos: el host del
// instituto, su certificado y la dependencia activa. La contraseña nunca se guarda y
// la sesión del SGD vive solo en memoria.
import { readFileSync, existsSync } from 'node:fs';
import { atomicWriteJson } from './atomic-write.ts';
import { appDataDir, configPath } from './paths.ts';

export interface Config {
  host: string; // base https del SGD del instituto; vacío hasta que el usuario lo configure
  ca?: string; // certificado o cadena de confianza del instituto (PEM)
  coDep?: string;
  depName?: string;
}

export interface Session {
  jsessionid: string;
  user: string;
  createdAt: string;
}

export const EMPTY_CONFIG: Config = { host: '' };

// Lee la configuración del directorio dado. Si no existe o está dañada, devuelve la vacía.
export function loadConfig(dir: string = appDataDir()): Config {
  const path = configPath(dir);
  if (!existsSync(path)) return { ...EMPTY_CONFIG };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
    return { ...EMPTY_CONFIG, ...parsed };
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

export function saveConfig(config: Config, dir: string = appDataDir()): void {
  atomicWriteJson(configPath(dir), config, 0o600);
}
