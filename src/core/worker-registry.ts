import { QuestDomainError } from "./errors";
import { readJsonFileOrDefault, resolveWorkerRegistryPath, writeJsonFileAtomically } from "./storage";
import {
  registeredWorkerSchema,
  type RegisteredWorker,
  workerRegistrySchema,
  type WorkerRegistryDocument,
} from "./worker-schema";

const EMPTY_WORKER_REGISTRY: WorkerRegistryDocument = {
  version: 1,
  workers: [],
};

export class WorkerRegistry {
  constructor(
    private readonly registryPath: string = resolveWorkerRegistryPath(),
  ) {}

  async read(): Promise<WorkerRegistryDocument> {
    const rawDocument = await readJsonFileOrDefault<WorkerRegistryDocument>(this.registryPath, EMPTY_WORKER_REGISTRY);
    const parsed = workerRegistrySchema.safeParse(rawDocument);

    if (!parsed.success) {
      throw new QuestDomainError({
        code: "invalid_worker_registry",
        details: parsed.error.flatten(),
        message: `Worker registry at ${this.registryPath} is invalid`,
        statusCode: 1,
      });
    }

    return parsed.data;
  }

  async listWorkers(): Promise<RegisteredWorker[]> {
    const document = await this.read();
    return document.workers;
  }

  async upsertWorker(candidate: RegisteredWorker): Promise<RegisteredWorker> {
    const parsedWorker = registeredWorkerSchema.safeParse(candidate);
    if (!parsedWorker.success) {
      throw new QuestDomainError({
        code: "invalid_worker_definition",
        details: parsedWorker.error.flatten(),
        message: "Worker definition is invalid",
        statusCode: 1,
      });
    }

    const document = await this.read();
    const existingIndex = document.workers.findIndex((worker) => worker.id === parsedWorker.data.id);
    const nextWorkers = [...document.workers];

    if (existingIndex >= 0) {
      nextWorkers[existingIndex] = parsedWorker.data;
    } else {
      nextWorkers.push(parsedWorker.data);
    }

    const nextDocument: WorkerRegistryDocument = {
      version: 1,
      workers: nextWorkers.sort((left, right) => left.id.localeCompare(right.id)),
    };

    await writeJsonFileAtomically(this.registryPath, nextDocument);
    return parsedWorker.data;
  }
}
