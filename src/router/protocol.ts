export type RouterMode = "on" | "fallback";

export type RouterFileRecord = {
  path: string;
  size: number;
  mime: string;
  blob: Blob;
};

export type RouterFileInfo = Omit<RouterFileRecord, "blob">;

export type RouterState = {
  mode: RouterMode;
  fileCount: number;
};

export type RouterRequest =
  | { id: string; type: "connect" }
  | { id: string; type: "getStatus" }
  | { id: string; type: "setMode"; mode: RouterMode }
  | { id: string; type: "putFiles"; files: RouterFileRecord[] }
  | { id: string; type: "deleteFiles"; paths: string[] }
  | { id: string; type: "clearFiles" }
  | { id: string; type: "getFile"; path: string }
  | { id: string; type: "listFiles" };

export type RouterStreamEvent =
  | { type: "state"; state: RouterState }
  | {
      type: "progress";
      stage: "put" | "delete" | "clear";
      current: number;
      total: number;
    }
  | { type: "log"; message: string }
  | { type: "error"; message: string };

export type RouterResultEvent =
  | { type: "result"; requestId: string; ok: true; data?: unknown }
  | { type: "result"; requestId: string; ok: false; error: string };

export type RouterEvent = RouterStreamEvent | RouterResultEvent;
