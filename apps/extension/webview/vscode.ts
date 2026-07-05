import type { WebviewToHost } from "../src/protocol.js";

interface VsCodeApi {
  postMessage(msg: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

export function post(msg: WebviewToHost): void {
  api.postMessage(msg);
}
