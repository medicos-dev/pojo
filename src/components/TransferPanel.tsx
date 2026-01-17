import { useEffect, useState, useRef, useCallback } from 'react';
import { SenderPanel } from './SenderPanel';
import { ReceiverPanel } from './ReceiverPanel';
import { StatusBar } from './StatusBar';
import { Footer } from './Footer';
import { FileSender, InternalTransferProgress } from '../transfer/sender';
import { FileReceiver, InternalReceiverProgress } from '../transfer/receiver';
import { sendControl, registerDataHandlers } from '../webrtc/dataChannel';
import { ControlMessage } from '../types/signaling';
import { initDB } from '../storage/indexedDb';

export const TransferPanel = ({ roomId, onLeave }: { roomId: string, onLeave: () => void }) => {
    const [mode, setMode] = useState<'idle' | 'sender' | 'receiver'>('idle');
    const [copyFeedback, setCopyFeedback] = useState(false);

    // Sender State
    const [senderFile, setSenderFile] = useState<File | null>(null);
    const [fileQueue, setFileQueue] = useState<File[]>([]);
    const [currentFileIndex, setCurrentFileIndex] = useState(0);
    const [senderProgress, setSenderProgress] = useState<InternalTransferProgress | null>(null);
    const [senderStatus, setSenderStatus] = useState<'idle' | 'waiting' | 'uploading' | 'complete' | 'paused' | 'error'>('idle');
    const [senderError, setSenderError] = useState<string | null>(null);
    const senderRef = useRef<FileSender | null>(null);

    // Receiver State
    const [receiverMeta, setReceiverMeta] = useState<{ name: string, size: number, mimeType: string } | null>(null);
    const [receiverProgress, setReceiverProgress] = useState<InternalReceiverProgress | null>(null);
    const [receiverStatus, setReceiverStatus] = useState<'idle' | 'offering' | 'receiving' | 'complete' | 'finalizing' | 'error'>('idle');
    const [receiverError, setReceiverError] = useState<string | null>(null);
    const receiverRef = useRef<FileReceiver | null>(null);

    // REFS to avoid stale closures in callbacks
    const modeRef = useRef(mode);
    const senderStatusRef = useRef(senderStatus);
    useEffect(() => { modeRef.current = mode; }, [mode]);
    useEffect(() => { senderStatusRef.current = senderStatus; }, [senderStatus]);

    const copyRoomId = () => {
        navigator.clipboard.writeText(roomId);
        setCopyFeedback(true);
        setTimeout(() => setCopyFeedback(false), 2000);
    };

    const handleChannelState = useCallback((type: 'control' | 'data', open: boolean) => {
        if (type === 'data' && !open) {
            console.warn('Data Channel Closed');
        }
    }, []);

    const handleControlMessage = useCallback((msg: ControlMessage) => {
        switch (msg.type) {
            case 'file-request':
                if (modeRef.current === 'sender') {
                    return;
                }
                setMode('receiver');
                setReceiverMeta({
                    name: msg.name!,
                    size: msg.size!,
                    mimeType: msg.mimeType || 'application/octet-stream'
                });
                setReceiverStatus('offering');
                setReceiverError(null);
                break;

            case 'file-accept':
                if (modeRef.current === 'sender' && senderStatusRef.current === 'waiting') {
                    if (senderRef.current) {
                        senderRef.current.start();
                    }
                }
                break;

            case 'file-reject':
                if (modeRef.current === 'sender') {
                    setSenderStatus('error');
                    setSenderError('Peer rejected file transfer.');
                }
                break;

            case 'ack':
            case 'file-complete':
                break;

            case 'cancel':
                if (modeRef.current === 'receiver') {
                    setReceiverStatus('error');
                    setReceiverError('Transfer cancelled by sender.');
                    if (receiverRef.current) {
                        // receiverRef.current.abort(); // If receiver had abort method
                    }
                }
                break;
        }
    }, []);

    const handleBinaryData = useCallback((data: ArrayBuffer) => {
        if (receiverRef.current && modeRef.current === 'receiver') {
            receiverRef.current.handleChunk(data);
        }
    }, []);

    useEffect(() => {
        initDB().catch(console.error);
        registerDataHandlers(handleControlMessage, handleBinaryData, handleChannelState);
    }, [handleControlMessage, handleBinaryData, handleChannelState]);

    // --- SENDER ACTIONS ---

    const handleFilesSelect = (files: File[]) => {
        setMode('sender');
        setFileQueue(files);
        setCurrentFileIndex(0);
        setSenderFile(files[0]);
        setSenderStatus('idle');
        setSenderError(null);
        setSenderProgress(null);
    };

    const handleSenderStart = () => {
        if (!senderFile) return;

        // Setup Sender
        senderRef.current = new FileSender(
            senderFile,
            (progress) => setSenderProgress(progress),
            (status, err) => {
                if (status === 'uploading') setSenderStatus('uploading');
                if (status === 'complete') setSenderStatus('complete');
                if (status === 'error') {
                    setSenderStatus('error');
                    setSenderError(err || 'Unknown error');
                }
            }
        );

        // Send Request
        setSenderStatus('waiting');
        sendControl({
            type: 'file-request',
            name: senderFile.name,
            size: senderFile.size,
            mimeType: senderFile.type
        });
    };

    // Auto-advance to next file when current completes
    useEffect(() => {
        if (senderStatus === 'complete' && currentFileIndex < fileQueue.length - 1) {
            // Auto-start next file
            const nextIndex = currentFileIndex + 1;
            setCurrentFileIndex(nextIndex);
            setSenderFile(fileQueue[nextIndex]);
            setSenderStatus('idle');
            setSenderProgress(null);
            // Auto-start after brief delay to let UI update
            setTimeout(() => {
                handleSenderStart();
            }, 500);
        }
    }, [senderStatus, currentFileIndex, fileQueue]);

    const handleSenderAbort = () => {
        if (senderRef.current) senderRef.current.abort();

        // Notify peer of abort
        if (mode === 'sender' && (senderStatus === 'uploading' || senderStatus === 'waiting' || senderStatus === 'paused')) {
            sendControl({ type: 'cancel' } as any);
        }

        setMode('idle');
        setSenderFile(null);
        setFileQueue([]);
        setCurrentFileIndex(0);
    };

    // prevent accidental leave
    useEffect(() => {
        const handleBeforeUnload = (e: BeforeUnloadEvent) => {
            if (roomId) {
                e.preventDefault();
                e.returnValue = '';
            }
        };
        window.addEventListener('beforeunload', handleBeforeUnload);
        return () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }, [roomId]);

    // --- RECEIVER ACTIONS ---

    const handleAccept = () => {
        if (!receiverMeta) return;

        console.log('📥 Accepting file transfer...');
        setReceiverStatus('receiving');
        receiverRef.current = new FileReceiver(
            receiverMeta,
            (progress) => setReceiverProgress(progress),
            (status, data) => {
                if (status === 'receiving') setReceiverStatus('receiving'); // 'finalizing' comes as data string? logic fix needed
                // data argument in wrapper:
                // Wrapper signature: (status, data?)
                if (status === 'receiving' && data === 'finalizing') {
                    setReceiverStatus('finalizing');
                }
                if (status === 'complete') {
                    setReceiverStatus('complete');
                    triggerDownload(data as Blob, receiverMeta.name);
                }
                if (status === 'error') {
                    setReceiverStatus('error');
                    setReceiverError(data as string);
                }
            }
        );

        const sent = sendControl({ type: 'file-accept' });
        console.log('📤 file-accept sent:', sent);
    };

    const handleReject = () => {
        sendControl({ type: 'file-reject' });
        setMode('idle');
        setReceiverMeta(null);
    };

    const triggerDownload = (blob: Blob, filename: string) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    const handleResetReceiver = () => {
        setMode('idle');
        setReceiverMeta(null);
        setReceiverStatus('idle');
        setReceiverError(null);
        setReceiverRef(null);
    };

    // Helper to clear ref safely (React ref mutation is fine)
    const setReceiverRef = (val: any) => { receiverRef.current = val; };

    return (
        <div className="app-container">
            <div style={{ maxWidth: '550px', width: '100%' }}>
                {/* Room Header */}
                <div className="retro-card" style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '1.5rem',
                    padding: '1.2rem 1.5rem'
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <div className="font-mono text-muted" style={{ fontSize: '0.85rem' }}>ROOM</div>
                        <div className="font-mono room-code">{roomId}</div>
                        <button
                            className="retro-btn"
                            style={{ padding: '0.5rem 1rem', fontSize: '0.75rem' }}
                            onClick={copyRoomId}
                        >
                            {copyFeedback ? '✓ COPIED' : 'COPY'}
                        </button>
                    </div>
                    <button
                        className="retro-btn"
                        onClick={onLeave}
                        style={{
                            borderColor: 'var(--accent-red)',
                            color: 'var(--accent-red)',
                            padding: '0.5rem 1rem',
                            fontSize: '0.75rem'
                        }}
                    >
                        LEAVE
                    </button>
                </div>

                <StatusBar roomId={roomId} />

                <div style={{ marginTop: '2rem' }}>
                    {mode === 'receiver' ? (
                        <ReceiverPanel
                            fileMetadata={receiverMeta}
                            progress={receiverProgress}
                            status={receiverStatus}
                            error={receiverError}
                            onAccept={handleAccept}
                            onReject={handleReject}
                            onReset={handleResetReceiver}
                        />
                    ) : (
                        <SenderPanel
                            file={senderFile}
                            fileQueue={fileQueue}
                            currentIndex={currentFileIndex}
                            progress={senderProgress}
                            status={senderStatus}
                            error={senderError}
                            onFilesSelect={handleFilesSelect}
                            onStart={handleSenderStart}
                            onPause={() => {
                                if (senderRef.current) senderRef.current.pause();
                                setSenderStatus('paused' as any); // Force state update
                            }}
                            onResume={() => {
                                if (senderRef.current) senderRef.current.resume();
                                setSenderStatus('uploading');
                            }}
                            onAbort={handleSenderAbort}
                        />
                    )}
                </div>

                <Footer />
            </div>
        </div>
    );
};
