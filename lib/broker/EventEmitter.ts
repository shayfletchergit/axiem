type Handler<T> = (payload: T) => void;

export class TypedEventEmitter<Events extends Record<string, unknown>> {
  private listeners: {
    [K in keyof Events]?: Set<Handler<Events[K]>>;
  } = {};

  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    if (!this.listeners[event]) this.listeners[event] = new Set();
    this.listeners[event]!.add(handler);
    return () => this.off(event, handler);
  }

  off<K extends keyof Events>(event: K, handler: Handler<Events[K]>): void {
    this.listeners[event]?.delete(handler);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    this.listeners[event]?.forEach((h) => h(payload));
  }

  removeAllListeners(): void {
    this.listeners = {};
  }
}
