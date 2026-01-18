import { useState, useRef, DragEvent } from 'react';
import { formatFileSize } from '../utils/format';
import { InternalTransferProgress } from '../transfer/sender';

interface Props {
    file: File | null;
    fileQueue: File[];
    currentIndex: number;
    progress: InternalTransferProgress | null;
    status: 'idle' | 'waiting' | 'uploading' | 'complete' | 'paused' | 'error';
    error: string | null;
    onFilesSelect: (files: File[]) => void;
    onStart: () => void;
    onPause: () => void;
    onResume: () => void;
    onAbort: () => void;
}

export const SenderPanel = ({ file, fileQueue, currentIndex, progress, status, error, onFilesSelect, onStart, onPause, onResume, onAbort }: Props) => {
    const [dragActive, setDragActive] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleDrag = (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === 'dragenter' || e.type === 'dragover') {
            setDragActive(true);
        } else if (e.type === 'dragleave') {
            setDragActive(false);
        }
    };

    const handleDrop = (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const files = Array.from(e.dataTransfer.files);
            onFilesSelect(files);
        }
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            const files = Array.from(e.target.files);
            onFilesSelect(files);
        }
    };

    const getFileIcon = (fileName: string) => {
        const ext = fileName.split('.').pop()?.toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext || '')) {
            return (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-cyan)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                    <circle cx="8.5" cy="8.5" r="1.5"></circle>
                    <polyline points="21 15 16 10 5 21"></polyline>
                </svg>
            );
        }
        if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext || '')) {
            return (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-orange)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect>
                    <line x1="7" y1="2" x2="7" y2="22"></line>
                    <line x1="17" y1="2" x2="17" y2="22"></line>
                    <line x1="2" y1="12" x2="22" y2="12"></line>
                    <line x1="2" y1="7" x2="7" y2="7"></line>
                    <line x1="2" y1="17" x2="7" y2="17"></line>
                    <line x1="17" y1="17" x2="22" y2="17"></line>
                    <line x1="17" y1="7" x2="22" y2="7"></line>
                </svg>
            );
        }
        if (['mp3', 'wav', 'flac', 'aac', 'ogg'].includes(ext || '')) {
            return (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 18V5l12-2v13"></path>
                    <circle cx="6" cy="18" r="3"></circle>
                    <circle cx="18" cy="16" r="3"></circle>
                </svg>
            );
        }
        if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext || '')) {
            return (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-orange)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 8v13H3V8"></path>
                    <path d="M1 3h22v5H1z"></path>
                    <path d="M10 12h4"></path>
                </svg>
            );
        }
        return (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
            </svg>
        );
    };

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
                    background: 'rgba(255, 159, 10, 0.15)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-orange)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                        <polyline points="17 8 12 3 7 8"></polyline>
                        <line x1="12" y1="3" x2="12" y2="15"></line>
                    </svg>
                </div>
                <div>
                    <h2 style={{
                        fontSize: '0.9375rem',
                        fontWeight: 500,
                        color: 'var(--text-primary)',
                        marginBottom: '0.125rem'
                    }}>
                        Send Files
                    </h2>
                    <p style={{
                        fontSize: '0.6875rem',
                        color: 'var(--text-tertiary)'
                    }}>
                        {fileQueue.length > 0 ? `${fileQueue.length} file${fileQueue.length > 1 ? 's' : ''} selected` : 'Select files to transfer'}
                    </p>
                </div>
            </div>

            {fileQueue.length === 0 ? (
                <div
                    className={`drop-zone ${dragActive ? 'active' : ''}`}
                    onDragEnter={handleDrag}
                    onDragLeave={handleDrag}
                    onDragOver={handleDrag}
                    onDrop={handleDrop}
                    onClick={() => fileInputRef.current?.click()}
                    style={{ minHeight: '120px', padding: '1.5rem 1rem' }}
                >
                    <div style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: '0.75rem',
                        position: 'relative',
                        zIndex: 1
                    }}>
                        <div style={{
                            width: '48px',
                            height: '48px',
                            borderRadius: '12px',
                            background: 'rgba(48, 209, 88, 0.08)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            transition: 'transform 0.3s ease'
                        }}>
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                <polyline points="17 8 12 3 7 8"></polyline>
                                <line x1="12" y1="3" x2="12" y2="15"></line>
                            </svg>
                        </div>
                        <div style={{ textAlign: 'center' }}>
                            <p style={{
                                fontSize: '0.875rem',
                                fontWeight: 500,
                                color: 'var(--text-primary)',
                                marginBottom: '0.25rem'
                            }}>
                                Drop files here
                            </p>
                            <p style={{
                                fontSize: '0.75rem',
                                color: 'var(--text-tertiary)'
                            }}>
                                or click to browse
                            </p>
                        </div>
                    </div>
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        style={{ display: 'none' }}
                        onChange={handleChange}
                    />
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    <div style={{
                        background: 'rgba(255, 255, 255, 0.02)',
                        borderRadius: 'var(--border-radius-md)',
                        padding: '0.5rem',
                        maxHeight: '120px',
                        overflowY: 'auto'
                    }}>
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            marginBottom: '0.5rem',
                            padding: '0 0.375rem'
                        }}>
                            <span style={{
                                fontSize: '0.625rem',
                                fontWeight: 500,
                                color: 'var(--text-tertiary)',
                                textTransform: 'uppercase',
                                letterSpacing: '0.08em'
                            }}>
                                Queue ({currentIndex + 1}/{fileQueue.length})
                            </span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                            {fileQueue.map((f, idx) => (
                                <div 
                                    key={idx}
                                    className={`file-item ${idx === currentIndex ? 'active' : ''} ${idx < currentIndex ? 'completed' : ''}`}
                                >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                        {idx < currentIndex ? (
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                <polyline points="20 6 9 17 4 12"></polyline>
                                            </svg>
                                        ) : idx === currentIndex ? (
                                            getFileIcon(f.name)
                                        ) : (
                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-quaternary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <circle cx="12" cy="12" r="10"></circle>
                                            </svg>
                                        )}
                                        <span style={{
                                            fontSize: '0.75rem',
                                            fontWeight: 500,
                                            color: idx === currentIndex ? 'var(--text-primary)' : 'var(--text-secondary)',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                            maxWidth: '160px'
                                        }}>
                                            {f.name}
                                        </span>
                                    </div>
                                    <span style={{
                                        fontSize: '0.625rem',
                                        color: 'var(--text-quaternary)'
                                    }}>
                                        {formatFileSize(f.size)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>

                    {file && (status === 'idle' || status === 'error') && (
                        <div style={{
                            padding: '0.75rem',
                            background: 'rgba(48, 209, 88, 0.06)',
                            borderRadius: 'var(--border-radius-sm)',
                            borderLeft: '2px solid var(--accent-green)'
                        }}>
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.625rem'
                            }}>
                                <div style={{
                                    width: '32px',
                                    height: '32px',
                                    borderRadius: '8px',
                                    background: 'rgba(255, 255, 255, 0.05)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center'
                                }}>
                                    {getFileIcon(file.name)}
                                </div>
                                <div>
                                    <p style={{
                                        fontSize: '0.8125rem',
                                        fontWeight: 500,
                                        color: 'var(--text-primary)',
                                        marginBottom: '0.125rem'
                                    }}>
                                        {file.name}
                                    </p>
                                    <p style={{
                                        fontSize: '0.6875rem',
                                        color: 'var(--text-tertiary)'
                                    }}>
                                        {formatFileSize(file.size)}
                                    </p>
                                </div>
                            </div>
                        </div>
                    )}

                    {(status === 'idle' || status === 'error') && (
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button className="btn-primary" onClick={onStart} style={{ flex: 1 }}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="22" y1="2" x2="11" y2="13"></line>
                                    <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                                </svg>
                                {status === 'error' ? 'Retry' : `Send ${fileQueue.length} File${fileQueue.length > 1 ? 's' : ''}`}
                            </button>
                            <button className="btn-secondary" onClick={onAbort}>
                                Clear
                            </button>
                        </div>
                    )}

                    {status === 'waiting' && (
                        <div style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: '0.75rem',
                            padding: '0.75rem'
                        }}>
                            <div style={{
                                width: '32px',
                                height: '32px',
                                border: '2px solid rgba(255, 159, 10, 0.2)',
                                borderTopColor: 'var(--accent-orange)',
                                borderRadius: '50%',
                                animation: 'spin 1s linear infinite'
                            }} />
                            <p style={{
                                fontSize: '0.8125rem',
                                fontWeight: 500,
                                color: 'var(--accent-orange)'
                            }}>
                                Waiting for peer...
                            </p>
                            <button className="btn-ghost" onClick={onAbort} style={{ fontSize: '0.75rem' }}>
                                Cancel
                            </button>
                        </div>
                    )}

                    {(status === 'uploading' || status === 'paused') && progress && (
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
                                        color: status === 'paused' ? 'var(--accent-orange)' : 'var(--accent-green)'
                                    }}>
                                        {status === 'paused' ? 'Paused' : `${formatFileSize(progress.speedBps)}/s`}
                                    </span>
                                </div>
                                <div className="progress-bar">
                                    <div 
                                        className="progress-fill" 
                                        style={{ 
                                            width: `${progress.percent}%`,
                                            opacity: status === 'paused' ? 0.6 : 1
                                        }} 
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
                                        {formatFileSize(progress.bytesSent)}
                                    </span>
                                    <span style={{
                                        fontSize: '0.625rem',
                                        color: 'var(--text-quaternary)'
                                    }}>
                                        {formatFileSize(progress.totalBytes)}
                                    </span>
                                </div>
                            </div>

                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                {status === 'uploading' ? (
                                    <button className="btn-secondary" onClick={onPause} style={{ flex: 1 }}>
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                            <rect x="6" y="4" width="4" height="16"></rect>
                                            <rect x="14" y="4" width="4" height="16"></rect>
                                        </svg>
                                        Pause
                                    </button>
                                ) : (
                                    <button className="btn-primary" onClick={onResume} style={{ flex: 1 }}>
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                            <polygon points="5 3 19 12 5 21 5 3"></polygon>
                                        </svg>
                                        Resume
                                    </button>
                                )}
                                <button className="btn-danger" onClick={onAbort}>
                                    Cancel
                                </button>
                            </div>
                        </div>
                    )}

                    {error && (
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
                    )}

                    {status === 'complete' && currentIndex < fileQueue.length - 1 && (
                        <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '0.5rem',
                            padding: '0.75rem'
                        }}>
                            <div style={{
                                width: '18px',
                                height: '18px',
                                border: '2px solid rgba(255, 159, 10, 0.2)',
                                borderTopColor: 'var(--accent-orange)',
                                borderRadius: '50%',
                                animation: 'spin 1s linear infinite'
                            }} />
                            <span style={{
                                fontSize: '0.8125rem',
                                color: 'var(--accent-orange)'
                            }}>
                                Next file...
                            </span>
                        </div>
                    )}

                    {status === 'complete' && currentIndex >= fileQueue.length - 1 && (
                        <div style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: '0.75rem',
                            padding: '1rem'
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
                            <p style={{
                                fontSize: '0.875rem',
                                fontWeight: 500,
                                color: 'var(--accent-green)'
                            }}>
                                Complete!
                            </p>
                            <button className="btn-secondary" onClick={onAbort} style={{ fontSize: '0.75rem' }}>
                                Send More
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};
