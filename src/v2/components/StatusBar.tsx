import { useEffect, useState } from 'react';
import { getSocket } from '../webrtc/signaling';
import { registerPCStateCallback } from '../webrtc/peerConnection';

interface Props {
    roomId: string | null;
}

export const StatusBar = (_props: Props) => {
    const [wsState, setWsState] = useState('Connecting...');
    const [pcState, setPcState] = useState<RTCPeerConnectionState>('new');

    useEffect(() => {
        const ws = getSocket();
        if (ws) {
            setWsState(ws.readyState === WebSocket.OPEN ? 'Connected' : 'Disconnected');
            const interval = setInterval(() => {
                setWsState(ws.readyState === WebSocket.OPEN ? 'Connected' : 'Connecting...');
            }, 2000);
            return () => clearInterval(interval);
        }
    }, []);

    useEffect(() => {
        registerPCStateCallback((state) => {
            setPcState(state);
        });
    }, []);

    const getDotClass = () => {
        if (pcState === 'connected') return 'status-dot connected';
        if (pcState === 'failed' || pcState === 'closed') return 'status-dot error';
        if (pcState === 'connecting') return 'status-dot connecting';
        return 'status-dot waiting';
    };

    const getStatusText = () => {
        if (pcState === 'connected') return '🔒 SECURE CONNECTION';
        if (pcState === 'connecting') return '🔄 NEGOTIATING...';
        if (pcState === 'disconnected') return '❌ PEER DISCONNECTED';
        return '⏳ WAITING FOR PEER';
    };

    const getStatusClass = () => {
        if (pcState === 'connected') return 'status-connected';
        if (pcState === 'connecting') return 'status-waiting';
        return '';
    };

    return (
        <div className="status-bar">
            <div className="status-left">
                <span className={getDotClass()}></span>
                <span className={`status-text ${getStatusClass()}`}>{getStatusText()}</span>
            </div>
            <div className="status-right">
                <span className={wsState === 'Connected' ? 'text-green' : 'text-amber'}>
                    ● {wsState.toUpperCase()}
                </span>
            </div>
        </div>
    );
};
