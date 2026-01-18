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

    const getStatusConfig = () => {
        if (pcState === 'connected') {
            return {
                icon: (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                    </svg>
                ),
                text: 'Secure',
                color: 'var(--accent-green)',
                bgColor: 'rgba(48, 209, 88, 0.08)',
                borderColor: 'rgba(48, 209, 88, 0.15)'
            };
        }
        if (pcState === 'connecting') {
            return {
                icon: (
                    <div style={{
                        width: '10px',
                        height: '10px',
                        border: '2px solid rgba(255, 159, 10, 0.2)',
                        borderTopColor: 'var(--accent-orange)',
                        borderRadius: '50%',
                        animation: 'spin 1s linear infinite'
                    }} />
                ),
                text: 'Connecting',
                color: 'var(--accent-orange)',
                bgColor: 'rgba(255, 159, 10, 0.08)',
                borderColor: 'rgba(255, 159, 10, 0.15)'
            };
        }
        if (pcState === 'disconnected' || pcState === 'failed' || pcState === 'closed') {
            return {
                icon: (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-red)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="15" y1="9" x2="9" y2="15"></line>
                        <line x1="9" y1="9" x2="15" y2="15"></line>
                    </svg>
                ),
                text: 'Disconnected',
                color: 'var(--accent-red)',
                bgColor: 'rgba(255, 69, 58, 0.08)',
                borderColor: 'rgba(255, 69, 58, 0.15)'
            };
        }
        return {
            icon: (
                <div style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: 'var(--accent-orange)',
                    animation: 'pulse 2s ease-in-out infinite'
                }} />
            ),
            text: 'Waiting',
            color: 'var(--accent-orange)',
            bgColor: 'rgba(255, 159, 10, 0.08)',
            borderColor: 'rgba(255, 159, 10, 0.15)'
        };
    };

    const config = getStatusConfig();

    return (
        <div
            className="glass-card-static"
            style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.625rem 1rem',
                animation: 'fadeIn 0.5s ease-out 0.1s both'
            }}
        >
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.25rem 0.625rem',
                background: config.bgColor,
                borderRadius: '100px',
                border: `1px solid ${config.borderColor}`
            }}>
                {config.icon}
                <span style={{
                    fontSize: '0.6875rem',
                    fontWeight: 500,
                    color: config.color
                }}>
                    {config.text}
                </span>
            </div>

            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.375rem',
                padding: '0.25rem 0.5rem',
                background: wsState === 'Connected' ? 'rgba(48, 209, 88, 0.06)' : 'rgba(255, 159, 10, 0.06)',
                borderRadius: '100px'
            }}>
                <div style={{
                    width: '5px',
                    height: '5px',
                    borderRadius: '50%',
                    background: wsState === 'Connected' ? 'var(--accent-green)' : 'var(--accent-orange)'
                }} />
                <span style={{
                    fontSize: '0.625rem',
                    fontWeight: 500,
                    color: wsState === 'Connected' ? 'var(--accent-green)' : 'var(--accent-orange)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em'
                }}>
                    {wsState}
                </span>
            </div>
        </div>
    );
};
