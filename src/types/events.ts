import type { ServerWebSocket } from "bun";
import type { LavalinkLoadResult } from "./lavalink";

export interface RpcHandshakeMessage {
    type: "handshake";
    clientId: string;
    clientName?: string;
    handlers: string[];
}

export interface RpcRequestMessage {
    type: "rpc_request";
    id: string;
    handler: string;
    data: {
        identifier: string;
        originalIdentifier: string;
        attempt: number;
        lastError?: string;
        context?: Record<string, any>;
    };
    timeoutMs: number;
}

export interface RpcResponseMessage {
    type: "rpc_response";
    id: string;
    success: boolean;
    data?: LavalinkLoadResult;
    error?: string;
}

export interface WsClientData {
    type: "event_hub" | "lavalink_passthrough";
    clientId: string;
    name?: string;
    handlers?: Set<string>;
    upstreamWs?: WebSocket;
    messageQueue?: (string | ArrayBuffer | Uint8Array)[];
    isUpstreamOpen?: boolean;
}

export type ProxyWebSocket = ServerWebSocket<WsClientData>;
