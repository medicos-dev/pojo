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

    // handleDownload removed (trust parent)

    if (!fileMetadata && status === 'idle') {
        return (
            <div className="retro-card" style={{ opacity: 0.7 }}>
                <h2 className="font-mono text-muted" style={{ marginTop: 0 }}>RECEIVER TERMINAL</h2>
                <div className="drop-zone" style={{ borderStyle: 'solid', borderColor: '#333', cursor: 'default' }}>
                    <p className="text-muted">WAITING FOR INCOMING SIGNALS...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="retro-card">
            <h2 className="font-mono text-blue" style={{ marginTop: 0 }}>RECEIVER TERMINAL</h2>

            {fileMetadata && (
                <div className="font-mono" style={{ marginBottom: '1rem' }}>
                    <div className="text-amber">INCOMING TRANSMISSION DETECTED</div>
                    <br />
                    <div>FILE: <span className="text-primary">{fileMetadata.name}</span></div>
                    <div>SIZE: <span className="text-muted">{formatFileSize(fileMetadata.size)}</span></div>
                    <div>TYPE: <span className="text-muted">{fileMetadata.mimeType}</span></div>
                </div>
            )}

            {status === 'offering' && (
                <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
                    <button className="retro-btn primary" onClick={onAccept}>ACCEPT DATA</button>
                    <button className="retro-btn" onClick={onReject}>REJECT</button>
                </div>
            )}

            {(status === 'receiving' || status === 'complete' || status === 'finalizing') && progress && (
                <div>
                    <div className="progress-container">
                        <div className="progress-fill" style={{ width: `${progress.percent}%` }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem' }}>
                        <span className="font-mono">{progress.percent.toFixed(1)}%</span>
                        <span className="font-mono">{formatFileSize(progress.speedBps)}/s</span>
                        <span className="text-muted">
                            {formatFileSize(progress.bytesReceived)} / {formatFileSize(progress.totalBytes)}
                        </span>
                    </div>
                </div>
            )}

            {status === 'finalizing' && (
                <div className="text-amber blink" style={{ marginTop: '1rem' }}>
                    ASSEMBLING FILE ON DISK...
                </div>
            )}

            {status === 'complete' && (
                <div className="text-green font-mono" style={{ marginTop: '1rem' }}>
                    <div>✓ RECEPTION COMPLETE</div>
                    <div style={{ fontSize: '0.8rem', opacity: 0.7 }}>File saved to Downloads</div>
                    <button className="retro-btn" style={{ marginTop: '1rem', marginLeft: '0.5rem' }} onClick={onReset}>
                        READY FOR NEXT
                    </button>
                </div>
            )}

            {error && (
                <div className="text-red font-mono" style={{ marginTop: '1rem' }}>
                    <div>ERROR: {error}</div>
                    <button className="retro-btn" style={{ marginTop: '1rem', borderColor: 'var(--accent-red)', color: 'var(--accent-red)' }} onClick={onReset}>
                        READY FOR NEXT
                    </button>
                </div>
            )}
        </div>
    );
};
