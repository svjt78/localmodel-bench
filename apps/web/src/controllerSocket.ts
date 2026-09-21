import type { ClientCommand, ControllerEvent } from "@ollama-local/shared";

export type ControllerEventListener = (event: ControllerEvent) => void;
export type ConnectionStatus = "connecting" | "open" | "closed";
export type StatusListener = (status: ConnectionStatus) => void;

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 8000;

export class ControllerSocket {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<ControllerEventListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  connect(): void {
    this.stopped = false;
    this.openSocket();
  }

  private openSocket(): void {
    this.setStatus("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.setStatus("open");
    });

    ws.addEventListener("message", (ev) => {
      const event = JSON.parse(ev.data as string) as ControllerEvent;
      for (const listener of this.listeners) listener(event);
    });

    const scheduleReconnect = () => {
      if (this.stopped || this.reconnectTimer) return;
      this.setStatus("closed");
      const delay = Math.min(
        RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt,
        RECONNECT_MAX_DELAY_MS,
      );
      this.reconnectAttempt += 1;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.openSocket();
      }, delay);
    };

    ws.addEventListener("close", scheduleReconnect);
    ws.addEventListener("error", scheduleReconnect);
  }

  private setStatus(status: ConnectionStatus): void {
    for (const listener of this.statusListeners) listener(status);
  }

  onEvent(listener: ControllerEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  send(command: ClientCommand): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(command));
      return true;
    }
    return false;
  }
}
