// Cola de trabajos con UN solo trabajo en curso a la vez. Todas las operaciones contra
// el SGD pasan por aquí: así dos búsquedas nunca se pisan la sesión (el SGD rota la
// cookie al cambiar de dependencia) y el tope de 1 request en vuelo se cumple también
// entre trabajos.
import { AppError } from '../sgd/lib/errors.ts';
import type { Notifier, ProgressEvent } from '../sgd/lib/io.ts';

export type JobStatus = 'en_cola' | 'en_curso' | 'listo' | 'error';

export interface JobError {
  code: string;
  message: string;
  hint?: string;
}

export interface Job {
  id: string;
  kind: string;
  status: JobStatus;
  progress: ProgressEvent | null;
  notas: string[];
  result: unknown;
  error: JobError | null;
  creado: string;
}

export class QueueFullError extends Error {
  constructor() {
    super('hay demasiadas consultas en cola; espera a que terminen');
    this.name = 'QueueFullError';
  }
}

const MAX_PENDIENTES = 10;
const MAX_HISTORIAL = 50; // trabajos terminados que se conservan para consultarlos
const MAX_NOTAS = 20;

interface Pendiente {
  job: Job;
  run: (notifier: Notifier) => Promise<unknown>;
}

export class JobQueue {
  private readonly jobs = new Map<string, Job>(); // orden de inserción = orden de creación
  private readonly pendientes: Pendiente[] = [];
  private enCurso = false;

  private readonly maxPendientes: number;

  constructor(maxPendientes = MAX_PENDIENTES) {
    this.maxPendientes = maxPendientes;
  }

  enqueue(kind: string, run: (notifier: Notifier) => Promise<unknown>): Job {
    if (this.pendientes.length >= this.maxPendientes) throw new QueueFullError();
    const job: Job = {
      id: crypto.randomUUID(),
      kind,
      status: 'en_cola',
      progress: null,
      notas: [],
      result: null,
      error: null,
      creado: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    this.pendientes.push({ job, run });
    this.podar();
    void this.avanzar();
    return job;
  }

  get(id: string): Job | null {
    return this.jobs.get(id) ?? null;
  }

  get cantidadPendientes(): number {
    return this.pendientes.length;
  }

  private async avanzar(): Promise<void> {
    if (this.enCurso) return;
    const next = this.pendientes.shift();
    if (!next) return;
    this.enCurso = true;
    const { job, run } = next;
    job.status = 'en_curso';
    const notifier: Notifier = {
      progress: (e) => {
        job.progress = e;
      },
      note: (m) => {
        if (job.notas.length < MAX_NOTAS) job.notas.push(m);
      },
    };
    try {
      job.result = await run(notifier);
      job.status = 'listo';
    } catch (e) {
      job.error = toJobError(e);
      job.status = 'error';
    } finally {
      job.progress = null;
      this.enCurso = false;
      void this.avanzar();
    }
  }

  // Conserva los trabajos pendientes y solo los últimos MAX_HISTORIAL terminados.
  private podar(): void {
    const terminados = [...this.jobs.values()].filter((j) => j.status === 'listo' || j.status === 'error');
    for (const j of terminados.slice(0, Math.max(0, terminados.length - MAX_HISTORIAL))) this.jobs.delete(j.id);
  }
}

// Convierte un error en algo seguro de mostrar: sin cuerpos de respuesta ni detalles internos.
export function toJobError(e: unknown): JobError {
  if (e instanceof AppError) {
    return { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) };
  }
  return { code: 'interno', message: 'ocurrió un error inesperado' };
}
