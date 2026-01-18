import { useState } from 'react';
import { Footer } from './Footer';

interface Props {
    onJoin: (room: string) => void;
    onCreate: () => void;
}

export const WelcomeScreen = ({ onJoin, onCreate }: Props) => {
    const [code, setCode] = useState('');

    const handleJoin = () => {
        if (code.length > 0) {
            onJoin(code.toUpperCase());
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && code.length >= 3) {
            handleJoin();
        }
    };

    return (
        <div className="app-container">
            <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '1.5rem',
                maxWidth: '380px',
                width: '100%'
            }}>
                <div style={{
                    textAlign: 'center',
                    animation: 'slideUp 0.6s ease-out'
                }}>
                    <div style={{
                        width: '64px',
                        height: '64px',
                        margin: '0 auto 0.75rem',
                        borderRadius: '16px',
                        background: 'rgba(48, 209, 88, 0.1)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        animation: 'float 3s ease-in-out infinite'
                    }}>
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path>
                            <polyline points="14 2 14 8 20 8"></polyline>
                            <path d="M12 18v-6"></path>
                            <path d="M9 15l3-3 3 3"></path>
                        </svg>
                    </div>
                    <h1 style={{
                        fontSize: 'clamp(2rem, 7vw, 2.5rem)',
                        fontWeight: 500,
                        marginBottom: '0.5rem',
                        color: 'var(--text-primary)'
                    }}>
                        POJO Files
                    </h1>
                    <p style={{
                        fontSize: '0.9375rem',
                        color: 'var(--text-tertiary)'
                    }}>
                        Secure peer-to-peer file sharing
                    </p>
                </div>

                <div 
                    className="glass-card-static"
                    style={{
                        width: '100%',
                        padding: '1.5rem',
                        animation: 'scaleIn 0.5s ease-out 0.15s both'
                    }}
                >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                        <div>
                            <label style={{
                                display: 'block',
                                fontSize: '0.6875rem',
                                fontWeight: 500,
                                color: 'var(--text-tertiary)',
                                textTransform: 'uppercase',
                                letterSpacing: '0.08em',
                                marginBottom: '0.5rem'
                            }}>
                                Enter Room Code
                            </label>
                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                <input
                                    className="input-field"
                                    value={code}
                                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                                    onKeyDown={handleKeyDown}
                                    placeholder="ABC123"
                                    maxLength={6}
                                    style={{
                                        flex: 1,
                                        fontSize: '1rem',
                                        letterSpacing: '0.15em'
                                    }}
                                />
                                <button 
                                    className="btn-secondary"
                                    onClick={handleJoin} 
                                    disabled={code.length < 3}
                                    style={{
                                        padding: '0.75rem 1.25rem',
                                        opacity: code.length < 3 ? 0.5 : 1,
                                        cursor: code.length < 3 ? 'not-allowed' : 'pointer'
                                    }}
                                >
                                    Join
                                </button>
                            </div>
                        </div>

                        <div className="divider">or</div>

                        <button 
                            className="btn-primary"
                            onClick={onCreate}
                            style={{
                                width: '100%',
                                padding: '0.875rem'
                            }}
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="12" y1="5" x2="12" y2="19"></line>
                                <line x1="5" y1="12" x2="19" y2="12"></line>
                            </svg>
                            Create New Room
                        </button>
                    </div>
                </div>

                <div style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '0.75rem',
                    justifyContent: 'center',
                    animation: 'fadeIn 0.6s ease-out 0.3s both'
                }}>
                    <FeaturePill 
                        icon={
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                            </svg>
                        } 
                        text="Encrypted" 
                    />
                    <FeaturePill 
                        icon={
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                            </svg>
                        } 
                        text="No limits" 
                    />
                    <FeaturePill 
                        icon={
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="10"></circle>
                                <line x1="2" y1="12" x2="22" y2="12"></line>
                                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
                            </svg>
                        } 
                        text="P2P" 
                    />
                </div>

                <Footer />
            </div>
        </div>
    );
};

const FeaturePill = ({ icon, text }: { icon: React.ReactNode; text: string }) => (
    <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.375rem',
        padding: '0.375rem 0.75rem',
        background: 'rgba(255, 255, 255, 0.04)',
        borderRadius: '100px',
        fontSize: '0.75rem',
        color: 'var(--text-tertiary)',
        border: '1px solid rgba(255, 255, 255, 0.06)'
    }}>
        {icon}
        <span>{text}</span>
    </div>
);
