// Talking to Anki through the AnkiConnect add-on (https://ankiweb.net/shared/info/2055492159).
// Uses Obsidian's requestUrl, which isn't subject to browser CORS rules, so
// AnkiConnect's default config works without adding Obsidian to its allow list.

import { requestUrl } from "obsidian";
import type { AnkiApi } from "./sync";

export class AnkiConnect implements AnkiApi {
  constructor(private url: () => string) {}

  async call<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    let res;
    try {
      res = await requestUrl({
        url: this.url(),
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ action, version: 6, params }),
        throw: false,
      });
    } catch {
      throw new Error("Couldn't connect to Anki. Is it open, with AnkiConnect installed?");
    }
    if (res.status !== 200) throw new Error("AnkiConnect answered " + res.status);
    const data: unknown = res.json;
    if (!data || typeof data !== "object" || !("result" in data)) throw new Error("Unexpected answer from AnkiConnect");
    const answer = data as { result: unknown; error?: unknown };
    if (answer.error) throw new Error(typeof answer.error === "string" ? answer.error : JSON.stringify(answer.error));
    return answer.result as T;
  }
}
