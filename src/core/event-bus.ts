// ============================================================================
// EventBus — pub/sub typed event pipe
// ============================================================================

type EventHandler = (data: unknown) => void;

type EventName =
  | "log"
  | "task.progress"
  | "task.error"
  | "task.completed"
  | "task.state_change"
  | "plugin.registered";

class EventBus {
  private handlers = new Map<EventName, Set<EventHandler>>();

  on(event: EventName, handler: EventHandler): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off(event: EventName, handler: EventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: EventName, data: unknown): void {
    const handlers = this.handlers.get(event);
    if (!handlers) return;
    for (const fn of handlers) {
      try { fn(data); } catch { /* handler errors must not break the bus */ }
    }
  }

  /** Remove all handlers. Used on shutdown. */
  clear(): void {
    this.handlers.clear();
  }
}

// Singleton
export const eventBus = new EventBus();
