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

function normalizeBaseUrl(url: string): string {
    return url.replace(/\/+$/, '')
}

function parsePeerJSServerUrl(serverUrlString: string): PeerJSSignalingServer {
    const serverUrl = new URL(serverUrlString)

    return {
        host: serverUrl.hostname,
        port: serverUrl.port
            ? Number.parseInt(serverUrl.port, 10)
            : serverUrl.protocol === 'https:'
                ? 443
                : 80,
        path: serverUrl.pathname,
        secure: serverUrl.protocol === 'https:',
    }
}

export async function getIceServers(
    filePizzaServerUrl: string,
): Promise<RTCIceServer[]> {
    try {
        const response = await fetch(`${normalizeBaseUrl(filePizzaServerUrl)}/api/ice`, {
            method: 'POST',
        })

        if (!response.ok) {
            throw new Error(`Failed to get ICE servers: ${response.status}`)
        }

        const data = await response.json()
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
        const response = await fetch(
            `${normalizeBaseUrl(filePizzaServerUrl)}/api/peerjs-servers`,
        )

        if (!response.ok) {
            return undefined
        }

        const data = await response.json()
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

export async function createPeer(
    options: PeerJSConfigOptions,
): Promise<Peer> {
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