// Estado de la instancia: una sola sesión del SGD, en memoria. La configuración
// (host, certificado, dependencia) sí se persiste; la sesión y la contraseña nunca.
import { loadConfig, saveConfig } from '../sgd/lib/config.ts';
import type { Config, Session } from '../sgd/lib/config.ts';
import { appDataDir } from '../sgd/lib/paths.ts';

export class AppState {
  readonly dataDir: string;
  config: Config;
  session: Session | null = null;

  constructor(dataDir: string = appDataDir()) {
    this.dataDir = dataDir;
    this.config = loadConfig(dataDir);
  }

  guardarConfig(next: Config): void {
    this.config = next;
    saveConfig(next, this.dataDir);
  }

  cerrarSesion(): void {
    this.session = null;
  }
}
