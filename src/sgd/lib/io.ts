// Progreso y avisos de las operaciones largas hacia quien las llama (la interfaz).
// Reemplaza el stdout/stderr de la CLI: el núcleo no escribe en consola.
export interface ProgressEvent {
  fase: string; // texto para el usuario, ej. "dependencias revisadas"
  hechos: number;
  total: number; // 0 = sin conteo (la interfaz muestra la última nota y una barra indeterminada)
}

export interface Notifier {
  progress(event: ProgressEvent): void;
  note(message: string): void;
}

// Notificador que descarta todo. Es el valor por defecto para tests y llamadas internas.
export const silentNotifier: Notifier = {
  progress() {},
  note() {},
};
