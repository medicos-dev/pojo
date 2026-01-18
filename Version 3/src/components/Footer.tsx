import { useState } from 'react';

export const Footer = () => {
    const [showDonateModal, setShowDonateModal] = useState(false);
    const [showDevModal, setShowDevModal] = useState(false);

    return (
        <>
            <footer style={{
                width: '100%',
                padding: '1rem 0',
                marginTop: '1rem',
                borderTop: '1px solid rgba(255, 255, 255, 0.04)'
            }}>
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '1rem',
                    flexWrap: 'wrap'
                }}>
                    <button
                        onClick={() => setShowDevModal(true)}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            padding: '0.5rem 1rem',
                            background: 'rgba(255, 255, 255, 0.04)',
                            border: '1px solid rgba(255, 255, 255, 0.06)',
                            borderRadius: '100px',
                            cursor: 'pointer',
                            transition: 'all 0.2s ease'
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)';
                            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
                            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.06)';
                        }}
                    >
                        <img 
                            src="/aiks.jpg" 
                            alt="Developer" 
                            style={{
                                width: '28px',
                                height: '28px',
                                borderRadius: '50%',
                                objectFit: 'cover',
                                border: '2px solid rgba(255, 255, 255, 0.15)'
                            }} 
                        />
                        <span style={{
                            fontSize: '0.8125rem',
                            fontWeight: 500,
                            color: 'var(--text-secondary)'
                        }}>
                            AIKS
                        </span>
                    </button>

                    <button
                        onClick={() => setShowDonateModal(true)}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.375rem',
                            padding: '0.5rem 1rem',
                            background: 'var(--gradient-white)',
                            border: 'none',
                            borderRadius: '100px',
                            color: '#0a0a0a',
                            fontSize: '0.75rem',
                            fontWeight: 500,
                            cursor: 'pointer',
                            transition: 'all 0.2s ease'
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.transform = 'translateY(-1px)';
                            e.currentTarget.style.filter = 'brightness(0.95)';
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.transform = 'translateY(0)';
                            e.currentTarget.style.filter = 'brightness(1)';
                        }}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
                        </svg>
                        Support
                    </button>
                </div>
            </footer>

            {showDevModal && (
                <div 
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(0, 0, 0, 0.9)',
                        backdropFilter: 'blur(20px)',
                        WebkitBackdropFilter: 'blur(20px)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 10000,
                        animation: 'fadeIn 0.3s ease'
                    }}
                    onClick={() => setShowDevModal(false)}
                >
                    <div 
                        style={{
                            position: 'relative',
                            animation: 'scaleIn 0.3s ease'
                        }}
                        onClick={e => e.stopPropagation()}
                    >
                        <button 
                            onClick={() => setShowDevModal(false)}
                            style={{
                                position: 'absolute',
                                top: '-10px',
                                right: '-10px',
                                width: '32px',
                                height: '32px',
                                borderRadius: '50%',
                                background: 'rgba(255, 255, 255, 0.1)',
                                border: '1px solid rgba(255, 255, 255, 0.15)',
                                color: 'white',
                                fontSize: '1.125rem',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                transition: 'all 0.2s ease',
                                zIndex: 1
                            }}
                            onMouseEnter={(e) => {
                                e.currentTarget.style.background = 'rgba(255, 69, 58, 0.8)';
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                            }}
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                <line x1="6" y1="6" x2="18" y2="18"></line>
                            </svg>
                        </button>
                        <img 
                            src="/aiks.jpg" 
                            alt="Developer" 
                            style={{
                                width: '240px',
                                height: '240px',
                                borderRadius: '50%',
                                objectFit: 'cover',
                                border: '4px solid rgba(255, 255, 255, 0.15)',
                                boxShadow: '0 20px 50px rgba(0, 0, 0, 0.5)'
                            }} 
                        />
                    </div>
                </div>
            )}

            {showDonateModal && (
                <div 
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(0, 0, 0, 0.9)',
                        backdropFilter: 'blur(20px)',
                        WebkitBackdropFilter: 'blur(20px)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 10000,
                        animation: 'fadeIn 0.3s ease'
                    }}
                    onClick={() => setShowDonateModal(false)}
                >
                    <div 
                        style={{
                            position: 'relative',
                            maxWidth: '90vw',
                            maxHeight: '90vh',
                            animation: 'scaleIn 0.3s ease'
                        }}
                        onClick={e => e.stopPropagation()}
                    >
                        <button 
                            onClick={() => setShowDonateModal(false)}
                            style={{
                                position: 'absolute',
                                top: '-10px',
                                right: '-10px',
                                width: '32px',
                                height: '32px',
                                borderRadius: '50%',
                                background: 'rgba(255, 255, 255, 0.1)',
                                border: '1px solid rgba(255, 255, 255, 0.15)',
                                color: 'white',
                                fontSize: '1.125rem',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                transition: 'all 0.2s ease',
                                zIndex: 1
                            }}
                            onMouseEnter={(e) => {
                                e.currentTarget.style.background = 'rgba(255, 69, 58, 0.8)';
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)';
                            }}
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                <line x1="6" y1="6" x2="18" y2="18"></line>
                            </svg>
                        </button>
                        <img 
                            src="/donate.png" 
                            alt="Donation QR" 
                            style={{
                                maxWidth: '100%',
                                maxHeight: '75vh',
                                borderRadius: '16px',
                                boxShadow: '0 20px 50px rgba(0, 0, 0, 0.5)'
                            }} 
                        />
                    </div>
                </div>
            )}
        </>
    );
};
