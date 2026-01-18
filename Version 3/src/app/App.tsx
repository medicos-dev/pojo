import { useEffect, useState } from 'react';
import Lenis from 'lenis';
import { TransferPanel } from '../components/TransferPanel';
import { WelcomeScreen } from '../components/WelcomeScreen';
import { connectWebSocket, joinRoom, onSignal, sendSignal } from '../webrtc/signaling';
import { createPeerConnection, handleOffer, handleAnswer, handleIceCandidate } from '../webrtc/peerConnection';

function App() {
    const [roomId, setRoomId] = useState<string | null>(null);

    useEffect(() => {
        const lenis = new Lenis({
            duration: 1.2,
            easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t))
        });

        function raf(time: number) {
            lenis.raf(time);
            requestAnimationFrame(raf);
        }

        requestAnimationFrame(raf);
        window.scrollTo(0, 0); // Fix scrolled-up issue

        return () => {
            lenis.destroy();
        };
    }, []);

    // 6-digit alphanumeric code generator
    const generateRoomCode = () => {
        return Math.random().toString(36).substring(2, 8).toUpperCase();
    };

    const initializeConnection = async (room: string, isInitiator: boolean) => {
        setRoomId(room);
        joinRoom(room);

        // Update URL
        const url = new URL(window.location.href);
        url.searchParams.set('room', room);
        window.history.pushState({}, '', url.toString());

        try {
            await connectWebSocket();

            onSignal(async (msg) => {
                // Update initiator status from server truth
                if (msg.type === 'joined') {
                    if (msg.isInitiator !== undefined) {
                        // We can't easily update the 'isInitiator' arg of this closure.
                        // But for now, we rely on the initial guess.
                        // If server says we are NOT initiator, but we thought we were -> we should back off?
                        // If server says we ARE initiator, but we thought not -> we should become one?
                        // Current Architecture Limit: 'initializeConnection' is one-shot.
                        // For now, let's just log.

                    }
                }

                if (msg.type === 'peer-joined') {
                    // Peer joined, if we are initiator (and waiting), we can ensure efficient connection.
                    // Ideally, we might want to send offer here if we haven't?
                    // But standard flow: Initiator creates offer immediately.
                    // If peer joins later, they receive the offer via signaling server (if stored) or we resend?
                    // Simple Signaling Server (server.cjs) relays messages.
                    // If we sent offer before peer joined, it might be lost if server doesn't cache.
                    // server.cjs DOES NOT seem to cache offers.
                    // SO: Initiator should send OFFER when 'peer-joined' received? 
                    // OR: Initiator sends offer immediately, and retries?
                    // Best practice: Wait for peer-joined if we are alone.

                    /*
                     Legacy Logic Check:
                     app.js Line 1184 handleSignalingMessage:
                     case 'peer-joined':
                        if (isInitiator) { createPeerConnection() -> createOffer() ... }
                    */
                    // YES. We must wait for peer-joined to create offer if we are initiator.
                    if (isInitiator) {
                        const pc = createPeerConnection(room, true);
                        const offer = await pc.createOffer();
                        await pc.setLocalDescription(offer);
                        sendSignal({ type: 'offer', offer, room });
                    }

                } else if (msg.type === 'room-state') {
                    // msg.peerCount > 1 implies peer is already there.
                    // We don't trigger offer here for Initiator to avoid race with 'peer-joined'.
                    // 'peer-joined' event is the trigger.
                    if (msg.peerCount && msg.peerCount > 1) {

                    }
                } else if (msg.type === 'offer') {
                    if (!isInitiator) {
                        // We are joiner.
                        createPeerConnection(room, false);
                        if (msg.offer) await handleOffer(msg.offer);
                    }
                } else if (msg.type === 'answer') {
                    if (isInitiator && msg.answer) {
                        await handleAnswer(msg.answer);
                    }
                } else if (msg.type === 'ice-candidate') {
                    if (msg.candidate) {
                        await handleIceCandidate(msg.candidate);
                    }
                }
            });

        } catch (e) {

        }
    };

    useEffect(() => {
        // Check URL for existing room
        const params = new URLSearchParams(window.location.search);
        const roomFromUrl = params.get('room');
        if (roomFromUrl) {
            // Check session storage for initiator status to persist across reloads
            const storedInitiator = sessionStorage.getItem('isInitiator') === 'true';
            // Only claim initiator if we have session proof, otherwise assume joiner (new link click)
            initializeConnection(roomFromUrl, storedInitiator);
        }
    }, []);

    const handleCreate = () => {
        const code = generateRoomCode();
        sessionStorage.setItem('isInitiator', 'true');
        initializeConnection(code, true);
    };

    const handleJoin = (code: string) => {
        sessionStorage.setItem('isInitiator', 'false');
        initializeConnection(code, false);
    };

    const handleLeave = () => {
        sessionStorage.removeItem('isInitiator');
        const url = new URL(window.location.href);
        url.searchParams.delete('room');
        window.history.replaceState({}, '', url.toString());
        window.location.href = url.origin + url.pathname;
    };

    if (!roomId) {
        return <WelcomeScreen onJoin={handleJoin} onCreate={handleCreate} />;
    }

    return (
        <TransferPanel roomId={roomId} onLeave={handleLeave} />
    );
}

export default App;
