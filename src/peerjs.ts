// src/peerjs.ts
import Peer, { PeerOptions } from 'peerjs'
import { PeerJSSignalingServer } from './types'

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
]

export type PeerJSConfigOptions = {
    filePizzaServerUrl: string
    iceServers?: RTCIceServer[]
    peerJSSignalingServer?: PeerJSSignalingServer
    discoverPeerJSSignalingServer?: boolean
}

type IceEndpointResponse = {
    host?: string
    path?: string
    port?: number
    secure?: boolean
    servers?: string[]
    iceServers?: RTCIceServer[]
}

function normalizeBaseUrl(url: string): string {
    return url.replace(/\/+$/, '')
}

function parsePeerJSServerUrl(serverUrlString: string): PeerJSSignalingServer {
    const serverUrl = new URL(serverUrlString)
    const secure = serverUrl.protocol === 'https:'
    return {
        host: serverUrl.hostname,
        port: serverUrl.port
            ? Number.parseInt(serverUrl.port, 10)
            : secure
                ? 443
                : 80,
        path: serverUrl.pathname,
        secure,
    }
}

const iceCache = new Map<string, Promise<IceEndpointResponse>>()

function fetchIceEndpoint(
    filePizzaServerUrl: string,
): Promise<IceEndpointResponse> {
    const baseUrl = normalizeBaseUrl(filePizzaServerUrl)
    const cached = iceCache.get(baseUrl)
    if (cached) {
        return cached
    }

    const promise = (async () => {
        const response = await fetch(`${baseUrl}/api/ice`, { method: 'POST' })
        if (!response.ok) {
            throw new Error(`Failed to fetch /api/ice: ${response.status}`)
        }
        return (await response.json()) as IceEndpointResponse
    })()

    promise.catch(() => iceCache.delete(baseUrl))
    iceCache.set(baseUrl, promise)
    return promise
}

export async function getIceServers(
    filePizzaServerUrl: string,
): Promise<RTCIceServer[]> {
    try {
        const data = await fetchIceEndpoint(filePizzaServerUrl)
        return data.iceServers || DEFAULT_ICE_SERVERS
    } catch (error) {
        console.error('Error getting ICE servers:', error)
        return DEFAULT_ICE_SERVERS
    }
}

export async function discoverPeerJSSignalingServer(
    filePizzaServerUrl: string,
): Promise<PeerJSSignalingServer | undefined> {
    try {
        const data = await fetchIceEndpoint(filePizzaServerUrl)

        if (data.host) {
            return {
                host: data.host,
                path: data.path,
                port: data.port,
                secure: data.secure,
            }
        }

        const firstServer = data.servers?.[0]
        if (!firstServer) {
            return undefined
        }
        return parsePeerJSServerUrl(firstServer)
    } catch (error) {
        console.error('Error discovering PeerJS signaling server:', error)
        return undefined
    }
}

export async function buildPeerOptions({
    filePizzaServerUrl,
    iceServers,
    peerJSSignalingServer,
    discoverPeerJSSignalingServer: shouldDiscover = true,
}: PeerJSConfigOptions): Promise<PeerOptions> {
    const resolvedIceServers =
        iceServers || (await getIceServers(filePizzaServerUrl))

    const discoveredPeerJSSignalingServer =
        peerJSSignalingServer || shouldDiscover
            ? peerJSSignalingServer ||
            (await discoverPeerJSSignalingServer(filePizzaServerUrl))
            : undefined

    return {
        ...discoveredPeerJSSignalingServer,
        config: {
            iceServers: resolvedIceServers,
        },
        debug: 2,
    }
}

export async function createPeer(options: PeerJSConfigOptions): Promise<Peer> {
    const peerOptions = await buildPeerOptions(options)
    const peer = new Peer(peerOptions)

    if (peer.id) {
        return peer
    }

    await new Promise<void>((resolve) => {
        const onOpen = () => {
            peer.off('open', onOpen)
            resolve()
        }
        peer.on('open', onOpen)
    })

    return peer
}
