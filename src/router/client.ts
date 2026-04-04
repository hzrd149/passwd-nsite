import type {
  RouterEvent,
  RouterMode,
  RouterRequest,
  RouterState,
  RouterStreamEvent,
} from "./protocol";
import routerServiceWorkerUrl from "./index.ts?worker&url";

type RouterRequestMap = {
  connect: void;
  getStatus: RouterState;
  setMode: RouterState;
};

type RouterMessageListener = (event: RouterStreamEvent) => void;

function createRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

class RouterClient {
  private readonly pendingRequests = new Map<
    string,
    { resolve: (value: any) => void; reject: (reason?: unknown) => void }
  >();

  private readonly listeners = new Set<RouterMessageListener>();
  private registration: ServiceWorkerRegistration | null = null;

  constructor() {
    navigator.serviceWorker.addEventListener("message", this.handleMessage);
  }

  async init(): Promise<this> {
    const workerUrl = import.meta.env.DEV
      ? "/router-dev.js"
      : routerServiceWorkerUrl;

    this.registration = await navigator.serviceWorker.register(workerUrl, {
      scope: "/",
      type: "module",
    });

    await navigator.serviceWorker.ready;
    await this.request("connect");
    return this;
  }

  subscribe(listener: RouterMessageListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  request<TType extends RouterRequest["type"]>(
    type: TType,
    payload?: Omit<Extract<RouterRequest, { type: TType }>, "id" | "type">,
  ): Promise<RouterRequestMap[TType]> {
    const target =
      this.registration?.active ??
      this.registration?.waiting ??
      this.registration?.installing;
    if (!target) {
      return Promise.reject(
        new Error("The router service worker is not ready yet."),
      );
    }

    const id = createRequestId();
    const request = { id, type, ...(payload ?? {}) } as Extract<
      RouterRequest,
      { type: TType }
    >;

    return new Promise<RouterRequestMap[TType]>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      target.postMessage(request);
    });
  }

  getStatus() {
    return this.request("getStatus");
  }

  setMode(mode: RouterMode) {
    return this.request("setMode", { mode });
  }

  async unregister() {
    await this.registration?.unregister();
    this.registration = null;
  }

  private readonly handleMessage = (event: MessageEvent<RouterEvent>) => {
    const message = event.data;
    if (!message || typeof message !== "object" || !("type" in message)) {
      return;
    }

    if (message.type === "result") {
      const pendingRequest = this.pendingRequests.get(message.requestId);
      if (!pendingRequest) {
        return;
      }

      this.pendingRequests.delete(message.requestId);

      if (message.ok) {
        pendingRequest.resolve(message.data);
        return;
      }

      pendingRequest.reject(new Error(message.error));
      return;
    }

    for (const listener of this.listeners) {
      listener(message);
    }
  };
}

let routerClientPromise: Promise<RouterClient> | null = null;

export function getRouterClient(): Promise<RouterClient> {
  if (!("serviceWorker" in navigator)) {
    return Promise.reject(
      new Error("This browser does not support service workers."),
    );
  }

  routerClientPromise ??= new RouterClient().init();
  return routerClientPromise;
}

export async function unregisterRouterClient(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  if (routerClientPromise) {
    const client = await routerClientPromise.catch(() => null);
    await client?.unregister();
    routerClientPromise = null;
    return;
  }

  const registration = await navigator.serviceWorker.getRegistration("/");
  await registration?.unregister();
}
