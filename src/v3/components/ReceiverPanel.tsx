import { useState, useEffect } from 'react';
import { formatFileSize } from '../utils/format';
import { InternalReceiverProgress } from '../transfer/receiver';

interface Props {
    fileMetadata: { name: string, size: number, mimeType: string } | null;
    progress: InternalReceiverProgress | null;
    status: 'idle' | 'offering' | 'receiving' | 'complete' | 'finalizing' | 'error';
    error: string | null;
    onAccept: () => void;
    onReject: () => void;
    onReset: () => void;
}

export const ReceiverPanel = ({
    fileMetadata,
    progress,
    status,
    error,
    onAccept,
    onReject,
    onReset
}: Props) => {

    const [showReset, setShowReset] = useState(false);
    useEffect(() => {
        if (status === 'complete') {
            const t = setTimeout(() => setShowReset(true), 2500);
            return () => clearTimeout(t);
        } else {
            setShowReset(false);
        }
    }, [status]);

    const getFileIcon = (fileName: string) => {
        const ext = fileName.split('.').pop()?.toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext || '')) {
            return (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-cyan)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                    <circle cx="8.5" cy="8.5" r="1.5"></circle>
                    <polyline points="21 15 16 10 5 21"></polyline>
                </svg>
            );
        }
        if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext || '')) {
            return (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-orange)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect>
                    <line x1="7" y1="2" x2="7" y2="22"></line>
                    <line x1="17" y1="2" x2="17" y2="22"></line>
                    <line x1="2" y1="12" x2="22" y2="12"></line>
                </svg>
            );
        }
        if (['mp3', 'wav', 'flac', 'aac', 'ogg'].includes(ext || '')) {
            return (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 18V5l12-2v13"></path>
                    <circle cx="6" cy="18" r="3"></circle>
                    <circle cx="18" cy="16" r="3"></circle>
                </svg>
            );
        }
        if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext || '')) {
            return (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-orange)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 8v13H3V8"></path>
                    <path d="M1 3h22v5H1z"></path>
                    <path d="M10 12h4"></path>
                </svg>
            );
        }
        return (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
            </svg>
        );
    };

    if (!fileMetadata && status === 'idle') {
        return (
            <div className="glass-card-static" style={{ padding: '1.25rem' }}>
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.625rem',
                    marginBottom: '1rem'
                }}>
                    <div style={{
                        width: '28px',
                        height: '28px',
                        borderRadius: '8px',
                        background: 'rgba(100, 210, 255, 0.12)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                    }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-cyan)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="7 10 12 15 17 10"></polyline>
                            <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                    </div>
                    <div>
                        <h2 style={{
                            fontSize: '0.9375rem',
                            fontWeight: 500,
                            color: 'var(--text-secondary)',
                            marginBottom: '0.125rem'
                        }}>
                            Receive Files
                        </h2>
                        <p style={{
                            fontSize: '0.6875rem',
                            color: 'var(--text-quaternary)'
                        }}>
                            Waiting for incoming files...
                        </p>
                    </div>
                </div>

                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '0.75rem',
                    padding: '1.5rem 1rem',
                    background: 'rgba(255, 255, 255, 0.02)',
                    borderRadius: 'var(--border-radius-lg)',
                    border: '1px solid rgba(255, 255, 255, 0.04)'
                }}>
                    <div style={{
                        width: '40px',
                        height: '40px',
                        borderRadius: '10px',
                        background: 'rgba(100, 210, 255, 0.08)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        animation: 'pulse 2s ease-in-out infinite'
                    }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-cyan)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline>
                            <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>
                        </svg>
                    </div>
                    <p style={{
                        fontSize: '0.8125rem',
                        color: 'var(--text-tertiary)',
                        textAlign: 'center'
                    }}>
                        Files will appear here
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="glass-card-static" style={{ padding: '1.25rem' }}>
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.625rem',
                marginBottom: '1rem'
            }}>
                <div style={{
                    width: '28px',
                    height: '28px',
                    borderRadius: '8px',
                    background: 'rgba(48, 209, 88, 0.12)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                        <polyline points="7 10 12 15 17 10"></polyline>
                        <line x1="12" y1="15" x2="12" y2="3"></line>
                    </svg>
                </div>
                <div>
                    <h2 style={{
                        fontSize: '0.9375rem',
                        fontWeight: 500,
                        color: 'var(--text-primary)',
                        marginBottom: '0.125rem'
                    }}>
                        Incoming File
                    </h2>
                    <p style={{
                        fontSize: '0.6875rem',
                        color: 'var(--accent-green)'
                    }}>
                        {status === 'offering' ? 'Accept to download' :
                            status === 'receiving' ? 'Downloading...' :
                                status === 'finalizing' ? 'Finalizing...' :
                                    status === 'complete' ? 'Complete' : 'Transfer'}
                    </p>
                </div>
            </div>

            {fileMetadata && (
                <div style={{
                    padding: '0.75rem',
                    background: 'rgba(48, 209, 88, 0.06)',
                    borderRadius: 'var(--border-radius-sm)',
                    borderLeft: '2px solid var(--accent-green)',
                    marginBottom: '1rem'
                }}>
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.625rem'
                    }}>
                        <div style={{
                            width: '36px',
                            height: '36px',
                            borderRadius: '8px',
                            background: 'rgba(255, 255, 255, 0.05)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                        }}>
                            {getFileIcon(fileMetadata.name)}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{
                                fontSize: '0.8125rem',
                                fontWeight: 500,
                                color: 'var(--text-primary)',
                                marginBottom: '0.125rem',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap'
                            }}>
                                {fileMetadata.name}
                            </p>
                            <div style={{
                                display: 'flex',
                                gap: '0.75rem',
                                fontSize: '0.6875rem',
                                color: 'var(--text-tertiary)'
                            }}>
                                <span>
                                    {formatFileSize(fileMetadata.size)}
                                </span>
                                <span style={{ opacity: 0.6 }}>
                                    {fileMetadata.mimeType.split('/')[0]}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {status === 'offering' && (
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button className="btn-primary" onClick={onAccept} style={{ flex: 1 }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="7 10 12 15 17 10"></polyline>
                            <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                        Accept
                    </button>
                    <button className="btn-danger" onClick={onReject}>
                        Decline
                    </button>
                </div>
            )}

            {(status === 'receiving' || status === 'complete' || status === 'finalizing') && progress && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    <div>
                        <div style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            marginBottom: '0.375rem'
                        }}>
                            <span style={{
                                fontSize: '1.25rem',
                                fontWeight: 500,
                                color: 'var(--text-primary)'
                            }}>
                                {progress.percent.toFixed(0)}%
                            </span>
                            <span style={{
                                fontSize: '0.75rem',
                                color: 'var(--accent-green)'
                            }}>
                                {formatFileSize(progress.speedBps)}/s
                            </span>
                        </div>
                        <div className="progress-bar">
                            <div
                                className="progress-fill"
                                style={{ width: `${progress.percent}%` }}
                            />
                        </div>
                        <div style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            marginTop: '0.375rem'
                        }}>
                            <span style={{
                                fontSize: '0.625rem',
                                color: 'var(--text-quaternary)'
                            }}>
                                {formatFileSize(progress.bytesReceived)}
                            </span>
                            <span style={{
                                fontSize: '0.625rem',
                                color: 'var(--text-quaternary)'
                            }}>
                                {formatFileSize(progress.totalBytes)}
                            </span>
                        </div>
                    </div>
                </div>
            )}

            {status === 'finalizing' && (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.5rem',
                    padding: '0.75rem',
                    marginTop: '0.25rem'
                }}>
                    <div style={{
                        width: '18px',
                        height: '18px',
                        border: '2px solid rgba(48, 209, 88, 0.2)',
                        borderTopColor: 'var(--accent-green)',
                        borderRadius: '50%',
                        animation: 'spin 1s linear infinite'
                    }} />
                    <span style={{
                        fontSize: '0.8125rem',
                        color: 'var(--accent-green)'
                    }}>
                        Assembling...
                    </span>
                </div>
            )}

            {status === 'complete' && (
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '0.75rem',
                    padding: '1rem',
                    marginTop: '0.25rem'
                }}>
                    <div style={{
                        width: '40px',
                        height: '40px',
                        borderRadius: '50%',
                        background: 'rgba(48, 209, 88, 0.12)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                    }}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                    </div>
                    <div style={{ textAlign: 'center' }}>
                        <p style={{
                            fontSize: '0.875rem',
                            fontWeight: 500,
                            color: 'var(--accent-green)',
                            marginBottom: '0.125rem'
                        }}>
                            Complete!
                        </p>
                        <p style={{
                            fontSize: '0.6875rem',
                            color: 'var(--text-tertiary)'
                        }}>
                            Saved to downloads
                        </p>
                    </div>
                    {showReset && (
                        <button className="btn-secondary" onClick={onReset} style={{ fontSize: '0.75rem' }}>
                            Ready for Next
                        </button>
                    )}
                </div>
            )}

            {error && (
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.75rem',
                    marginTop: '0.25rem'
                }}>
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        padding: '0.75rem',
                        background: 'rgba(255, 69, 58, 0.08)',
                        borderRadius: 'var(--border-radius-sm)',
                        border: '1px solid rgba(255, 69, 58, 0.15)'
                    }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-red)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10"></circle>
                            <line x1="12" y1="8" x2="12" y2="12"></line>
                            <line x1="12" y1="16" x2="12.01" y2="16"></line>
                        </svg>
                        <span style={{
                            fontSize: '0.75rem',
                            color: 'var(--accent-red)'
                        }}>
                            {error}
                        </span>
                    </div>
                    <button className="btn-secondary" onClick={onReset} style={{ fontSize: '0.75rem' }}>
                        Try Again
                    </button>
                </div>
            )}
        </div>
    );
};
