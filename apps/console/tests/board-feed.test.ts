/** The console's live board feed client: nudges become pulls, and anything else is ignored. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { openBoardFeed } from "../src/App.tsx";

class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket | undefined;
  readyState = 0;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  close() {
    this.closed = true;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("the live board feed client", () => {
  it("connects to the Change's feed and reports each board.seq frame", () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const seen: number[] = [];
    const feed = openBoardFeed("http://127.0.0.1:8787", "board run/1", (seq) => seen.push(seq));
    const socket = FakeSocket.last!;
    expect(socket.url).toBe("ws://127.0.0.1:8787/changes/board%20run%2F1/board/live");
    socket.onmessage?.({ data: JSON.stringify({ type: "board.seq", lastSeq: 7 }) });
    socket.onmessage?.({ data: "not json" });
    socket.onmessage?.({ data: JSON.stringify({ type: "pong" }) });
    expect(seen).toEqual([7]);
    expect(feed?.isOpen()).toBe(false);
    socket.readyState = 1;
    expect(feed?.isOpen()).toBe(true);
    feed?.close();
    expect(socket.closed).toBe(true);
  });

  it("uses wss for an https Worker, and returns null without WebSocket", () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    openBoardFeed("https://example.workers.dev", "c", () => undefined);
    expect(FakeSocket.last!.url.startsWith("wss://example.workers.dev/")).toBe(true);
    vi.stubGlobal("WebSocket", undefined);
    expect(openBoardFeed("http://x", "c", () => undefined)).toBeNull();
  });
});
