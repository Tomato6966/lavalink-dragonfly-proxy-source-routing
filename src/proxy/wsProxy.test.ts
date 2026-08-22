import { describe, expect, it } from "bun:test";
import { sanitizeWebSocketCloseCode } from "./wsProxy";

describe("WebSocket close-code safety", () => {
    it("forwards valid codes and replaces forbidden pseudo-codes", () => {
        expect(sanitizeWebSocketCloseCode(1000, 1011)).toBe(1000);
        expect(sanitizeWebSocketCloseCode(1006, 1011)).toBe(1011);
        expect(sanitizeWebSocketCloseCode(1015, 1011)).toBe(1011);
        expect(sanitizeWebSocketCloseCode(1016, 1011)).toBe(1011);
        expect(sanitizeWebSocketCloseCode(2000, 1011)).toBe(1011);
        expect(sanitizeWebSocketCloseCode(3000, 1011)).toBe(3000);
        expect(sanitizeWebSocketCloseCode(5000, 1000)).toBe(1000);
        expect(sanitizeWebSocketCloseCode(Number.NaN, 1000)).toBe(1000);
    });
});
