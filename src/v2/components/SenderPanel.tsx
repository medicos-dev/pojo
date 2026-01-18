import { useState, useRef, DragEvent } from 'react';
import { formatFileSize } from '../utils/format';
import { InternalTransferProgress } from '../transfer/sender';

interface Props {
    file: File | null;
    fileQueue: File[];
    currentIndex: number;
    progress: InternalTransferProgress | null;
    status: 'idle' | 'waiting' | 'uploading' | 'finalizing' | 'complete' | 'paused' | 'error';
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

    return (
        <div className="retro-card">
            <h2 className="font-mono text-amber" style={{ marginTop: 0 }}>SENDER TERMINAL</h2>

            {fileQueue.length === 0 ? (
                <div
                    className={`drop-zone ${dragActive ? 'active' : ''}`}
                    onDragEnter={handleDrag}
                    onDragLeave={handleDrag}
                    onDragOver={handleDrag}
                    onDrop={handleDrop}
                    onClick={() => fileInputRef.current?.click()}
                >
                    <p className="font-mono">DROP FILES HERE</p>
                    <p className="text-muted" style={{ fontSize: '0.9rem', marginTop: '0.5rem' }}>or click to browse (multiple allowed)</p>
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        style={{ display: 'none' }}
                        onChange={handleChange}
                    />
                </div>
            ) : (
                <div>
                    {/* File Queue Display */}
                    <div className="font-mono" style={{ marginBottom: '1rem' }}>
                        <div style={{ fontSize: '0.85rem', marginBottom: '0.5rem', opacity: 0.7 }}>
                            FILE QUEUE ({currentIndex + 1}/{fileQueue.length})
                        </div>
                        <div style={{ maxHeight: '150px', overflowY: 'auto' }}>
                            {fileQueue.map((f, idx) => (
                                <div key={idx} style={{
                                    padding: '0.5rem',
                                    background: idx === currentIndex ? 'rgba(127, 163, 124, 0.2)' : 'transparent',
                                    borderRadius: '8px',
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    marginBottom: '0.25rem'
                                }}>
                                    <span className={idx < currentIndex ? 'text-green' : idx === currentIndex ? 'text-amber' : 'text-muted'}>
                                        {idx < currentIndex ? '✓ ' : idx === currentIndex ? '► ' : '○ '}
                                        {f.name.length > 25 ? f.name.slice(0, 22) + '...' : f.name}
                                    </span>
                                    <span className="text-muted" style={{ fontSize: '0.8rem' }}>{formatFileSize(f.size)}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Current File Progress */}
                    {file && (
                        <div className="file-info">
                            <div>CURRENT: <span className="text-primary">{file.name}</span></div>
                            <div>SIZE: <span className="text-muted">{formatFileSize(file.size)}</span></div>
                        </div>
                    )}

                    {(status === 'idle' || status === 'error') && (
                        <div style={{ display: 'flex', gap: '1rem' }}>
                            <button className="retro-btn primary" onClick={onStart}>
                                {status === 'error' ? 'RETRY' : `SEND ${fileQueue.length} FILES`}
                            </button>
                            <button className="retro-btn" onClick={onAbort}>
                                CLEAR
                            </button>
                        </div>
                    )}

                    {status === 'waiting' && (
                        <div>
                            <p className="text-amber blink">WAITING FOR PEER ACCEPT...</p>
                            <button className="retro-btn" style={{ fontSize: '0.8rem', padding: '0.4rem 0.8rem' }} onClick={onAbort}>CANCEL</button>
                        </div>
                    )}

                    {(status === 'uploading' || status === 'finalizing' || status === 'paused') && progress && (
                        <div>
                            <div className="progress-container">
                                <div
                                    className="progress-fill"
                                    style={{
                                        width: `${progress.percent}%`,
                                        opacity: status === 'paused' ? 0.5 : 1
                                    }}
                                />
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem', marginBottom: '1rem' }}>
                                <span className="font-mono">{progress.percent.toFixed(1)}%</span>
                                <span className="font-mono">
                                    {status === 'paused' ? 'PAUSED' : status === 'finalizing' ? 'FINALIZING...' : `${formatFileSize(progress.speedBps)}/s`}
                                </span>
                                <span className="text-muted">{formatFileSize(progress.bytesSent)} / {formatFileSize(progress.totalBytes)}</span>
                            </div>

                            <div style={{ display: 'flex', gap: '1rem' }}>
                                {status === 'uploading' ? (
                                    <button className="retro-btn" onClick={onPause}>POSTPONE (PAUSE)</button>
                                ) : (
                                    <button className="retro-btn primary" onClick={onResume}>RESUME</button>
                                )}
                                <button className="retro-btn" style={{ borderColor: 'var(--accent-red)', color: 'var(--accent-red)' }} onClick={onAbort}>
                                    CANCEL
                                </button>
                            </div>
                        </div>
                    )}

                    {error && (
                        <div className="text-red font-mono" style={{ marginTop: '1rem' }}>
                            ERROR: {error}
                        </div>
                    )}

                    {status === 'complete' && currentIndex < fileQueue.length - 1 && (
                        <div className="text-amber font-mono" style={{ marginTop: '1rem' }}>
                            STARTING NEXT FILE...
                        </div>
                    )}

                    {status === 'complete' && currentIndex >= fileQueue.length - 1 && (
                        <div className="text-green font-mono" style={{ marginTop: '1rem', textAlign: 'center' }}>
                            ✓ ALL TRANSFERS COMPLETE
                            <button className="retro-btn" style={{ marginLeft: '1rem' }} onClick={onAbort}>
                                NEW TRANSFER
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};
