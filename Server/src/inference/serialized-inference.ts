import type { InferenceBackend } from "./native-inference.ts";
import { InferenceError } from "./inference-error.ts";

/** A shared model queue with independently cancellable callers. */
export class InferenceScheduler {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private scopes = new Set<InferenceScope>();

  constructor(private readonly backend: InferenceBackend) {}

  scope(): InferenceBackend {
    const scope = new InferenceScope(this, this.backend);
    this.scopes.add(scope);
    return scope;
  }

  enqueue<T>(operation: () => Promise<T>, signal: AbortSignal) {
    const result = this.queue.then(async () => {
      signal.throwIfAborted();
      if (this.closed) throw new InferenceError("unavailable", "The server is shutting down.");
      return operation();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  async shutdown() {
    this.closed = true;
    await Promise.allSettled([...this.scopes].map((scope) => scope.shutdown()));
    await this.backend.shutdown();
    await this.queue;
  }
}

class InferenceScope implements InferenceBackend {
  private controller = new AbortController();
  private closed = false;
  private pending = new Set<Promise<unknown>>();
  readonly findSpeechBoundary: InferenceBackend["findSpeechBoundary"];

  constructor(
    private readonly scheduler: InferenceScheduler,
    private readonly backend: InferenceBackend,
  ) {
    const boundary = backend.findSpeechBoundary;
    this.findSpeechBoundary = boundary
      ? (audioPath, signal, engine) =>
          this.run((combined) => boundary.call(backend, audioPath, combined, engine), signal)
      : undefined;
  }

  get timedSpeechSpans() {
    return this.backend.timedSpeechSpans;
  }

  get engines() {
    return this.backend.engines;
  }

  readiness(...args: Parameters<InferenceBackend["readiness"]>) {
    return this.backend.readiness(...args);
  }

  private run<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
    if (this.closed)
      return Promise.reject(new InferenceError("unavailable", "The inference caller is closed."));
    const combined = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;
    const result = this.scheduler.enqueue(() => operation(combined), combined);
    this.pending.add(result);
    void result.then(
      () => this.pending.delete(result),
      () => this.pending.delete(result),
    );
    return result;
  }

  warmUp(...args: Parameters<InferenceBackend["warmUp"]>) {
    const [proofreadingEnabled, signal, engine] = args;
    return this.run(
      (combined) => this.backend.warmUp(proofreadingEnabled, combined, engine),
      signal,
    );
  }

  transcribe(...args: Parameters<InferenceBackend["transcribe"]>) {
    const [path, language, terms, progress, signal, engine] = args;
    return this.run(
      (combined) => this.backend.transcribe(path, language, terms, progress, combined, engine),
      signal,
    );
  }

  correct(...args: Parameters<InferenceBackend["correct"]>) {
    const [text, terms, language, prompt, signal] = args;
    return this.run(
      (combined) => this.backend.correct(text, terms, language, prompt, combined),
      signal,
    );
  }

  async cancel() {
    this.controller.abort(new InferenceError("cancelled", "Inference was cancelled."));
    this.controller = new AbortController();
  }

  async shutdown() {
    this.closed = true;
    await this.cancel();
    await Promise.allSettled([...this.pending]);
  }
}
