// Carpeta de datos de la app, por sistema operativo. Solo guarda configuración no
// secreta: nunca contraseñas ni sesiones del SGD.
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_DIR = 'sgd-expedientes';

type Env = Record<string, string | undefined>;

export function appDataDir(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (platform === 'win32') {
    const base = env.APPDATA?.trim() || join(home, 'AppData', 'Roaming');
    return join(base, APP_DIR);
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', APP_DIR);
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(home, '.config'), APP_DIR);
}

export function configPath(dir: string = appDataDir()): string {
  return join(dir, 'config.json');
}
