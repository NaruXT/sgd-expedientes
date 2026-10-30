// Escritura atómica: escribe a un temporal y renombra, así un proceso muerto
// a mitad no deja un archivo de config/sesión truncado.
import { writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export function atomicWriteJson(path: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  try {
    chmodSync(tmp, mode);
  } catch {
    // chmod puede fallar en algunos FS; el mode de writeFileSync ya aplicó.
  }
  renameSync(tmp, path);
}
