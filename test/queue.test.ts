// Cola de trabajos: un trabajo a la vez, progreso visible, errores seguros y capacidad.
import { describe, expect, test } from 'bun:test';
import { JobQueue, QueueFullError } from '../src/server/queue.ts';
import { AppError } from '../src/sgd/lib/errors.ts';

// Espera a que un trabajo termine (listo o error) con un tope de tiempo.
async function esperar(queue: JobQueue, id: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const job = queue.get(id);
    if (job && (job.status === 'listo' || job.status === 'error')) return;
    await Bun.sleep(5);
  }
  throw new Error('el trabajo no terminó a tiempo');
}

function compuerta() {
  let abrir!: () => void;
  const promesa = new Promise<void>((resolve) => (abrir = resolve));
  return { esperar: () => promesa, abrir };
}

describe('JobQueue', () => {
  test('nunca ejecuta dos trabajos a la vez', async () => {
    const queue = new JobQueue();
    let activos = 0;
    let maxActivos = 0;
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(
        queue.enqueue('prueba', async () => {
          activos++;
          maxActivos = Math.max(maxActivos, activos);
          await Bun.sleep(15);
          activos--;
          return i;
        }).id,
      );
    }
    for (const id of ids) await esperar(queue, id);
    expect(maxActivos).toBe(1);
    expect(ids.map((id) => queue.get(id)!.result)).toEqual([0, 1, 2, 3]);
  });

  test('ejecuta en el orden en que se encolaron', async () => {
    const queue = new JobQueue();
    const orden: number[] = [];
    const ids = [1, 2, 3].map((n) =>
      queue.enqueue('prueba', async () => {
        orden.push(n);
      }).id,
    );
    for (const id of ids) await esperar(queue, id);
    expect(orden).toEqual([1, 2, 3]);
  });

  test('el progreso y las notas son visibles mientras el trabajo corre', async () => {
    const queue = new JobQueue();
    const gate = compuerta();
    const job = queue.enqueue('prueba', async (notifier) => {
      notifier.progress({ fase: 'búsqueda', hechos: 2, total: 5 });
      notifier.note('buscando');
      await gate.esperar();
      return 'ok';
    });
    await Bun.sleep(10);
    expect(queue.get(job.id)!.status).toBe('en_curso');
    expect(queue.get(job.id)!.progress).toEqual({ fase: 'búsqueda', hechos: 2, total: 5 });
    expect(queue.get(job.id)!.notas).toEqual(['buscando']);
    gate.abrir();
    await esperar(queue, job.id);
    expect(queue.get(job.id)!.progress).toBeNull();
  });

  test('un error de la app se expone con código y pista', async () => {
    const queue = new JobQueue();
    const job = queue.enqueue('prueba', async () => {
      throw new AppError('auth_failed', 'usuario o contraseña incorrectos', { hint: 'verificá tus datos' });
    });
    await esperar(queue, job.id);
    const final = queue.get(job.id)!;
    expect(final.status).toBe('error');
    expect(final.error).toEqual({ code: 'auth_failed', message: 'usuario o contraseña incorrectos', hint: 'verificá tus datos' });
  });

  test('un error inesperado no filtra su mensaje interno', async () => {
    const queue = new JobQueue();
    const job = queue.enqueue('prueba', async () => {
      throw new Error('detalle interno con datos sensibles');
    });
    await esperar(queue, job.id);
    expect(queue.get(job.id)!.error).toEqual({ code: 'interno', message: 'ocurrió un error inesperado' });
  });

  test('un fallo no detiene a los trabajos siguientes', async () => {
    const queue = new JobQueue();
    const malo = queue.enqueue('prueba', async () => {
      throw new AppError('network', 'falla');
    });
    const bueno = queue.enqueue('prueba', async () => 'listo');
    await esperar(queue, malo.id);
    await esperar(queue, bueno.id);
    expect(queue.get(bueno.id)!.result).toBe('listo');
  });

  test('rechaza trabajos cuando la cola de pendientes está llena', async () => {
    const queue = new JobQueue(1);
    const gate = compuerta();
    queue.enqueue('prueba', () => gate.esperar()); // en curso
    queue.enqueue('prueba', async () => 'pendiente'); // ocupa el único lugar de espera
    expect(() => queue.enqueue('prueba', async () => 'de más')).toThrow(QueueFullError);
    gate.abrir();
  });
});
