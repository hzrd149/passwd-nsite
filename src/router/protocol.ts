export type RouterMode = "on" | "fallback";

export type RouterFileRecord = {
  path: string;
  size: number;
  mime: string;
  blob: Blob;
};

export type RouterState = {
  mode: RouterMode;
};

export type RouterRequest =
  | { id: string; type: "connect" }
  | { id: string; type: "getStatus" }
  | { id: string; type: "setMode"; mode: RouterMode };

export type RouterStreamEvent =
  | { type: "state"; state: RouterState }
  | { type: "error"; message: string };

export type RouterResultEvent =
  | { type: "result"; requestId: string; ok: true; data?: unknown }
  | { type: "result"; requestId: string; ok: false; error: string };

export type RouterEvent = RouterStreamEvent | RouterResultEvent;
