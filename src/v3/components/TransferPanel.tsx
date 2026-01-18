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

    const [senderFile, setSenderFile] = useState<File | null>(null);
    const [fileQueue, setFileQueue] = useState<File[]>([]);
    const [currentFileIndex, setCurrentFileIndex] = useState(0);
    const [senderProgress, setSenderProgress] = useState<InternalTransferProgress | null>(null);
    const [senderStatus, setSenderStatus] = useState<'idle' | 'waiting' | 'uploading' | 'complete' | 'paused' | 'error'>('idle');
    const [senderError, setSenderError] = useState<string | null>(null);
    const senderRef = useRef<FileSender | null>(null);

    const [receiverMeta, setReceiverMeta] = useState<{ name: string, size: number, mimeType: string } | null>(null);
    const [receiverProgress, setReceiverProgress] = useState<InternalReceiverProgress | null>(null);
    const [receiverStatus, setReceiverStatus] = useState<'idle' | 'offering' | 'receiving' | 'complete' | 'finalizing' | 'error'>('idle');
    const [receiverError, setReceiverError] = useState<string | null>(null);
    const receiverRef = useRef<FileReceiver | null>(null);

    const modeRef = useRef(mode);
    const senderStatusRef = useRef(senderStatus);
    useEffect(() => { modeRef.current = mode; }, [mode]);
    useEffect(() => { senderStatusRef.current = senderStatus; }, [senderStatus]);

    const copyRoomId = () => {
        navigator.clipboard.writeText(roomId);
        setCopyFeedback(true);
        setTimeout(() => setCopyFeedback(false), 2000);
    };

    const shareRoom = async () => {
        const shareUrl = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
        if (navigator.share) {
            try {
                await navigator.share({
                    title: 'Join my POJO Files room',
                    text: `Join room ${roomId} to share files`,
                    url: shareUrl
                });
            } catch { }
        } else {
            navigator.clipboard.writeText(shareUrl);
            setCopyFeedback(true);
            setTimeout(() => setCopyFeedback(false), 2000);
        }
    };

    const handleChannelState = useCallback((type: 'control' | 'data', open: boolean) => {
        if (type === 'data' && !open) { }
    }, []);

    const handleControlMessage = useCallback((msg: ControlMessage) => {
        switch (msg.type) {
            case 'file-request':
                // Don't accept file requests while actively sending
                if (modeRef.current === 'sender' && senderStatusRef.current !== 'idle' && senderStatusRef.current !== 'complete') {
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
                setReceiverProgress(null);
                break;

            case 'file-accept':
                if (modeRef.current === 'sender' && senderStatusRef.current === 'waiting') {
                    if (senderRef.current) senderRef.current.start();
                }
                break;

            case 'file-reject':
                if (modeRef.current === 'sender') {
                    setSenderStatus('error');
                    setSenderError('Peer rejected file transfer.');
                }
                break;

            case 'ack':
                break;

            case 'file-complete':
                // Receiver has finished downloading, sender can now proceed to next file
                if (modeRef.current === 'sender') {
                    console.log('Receiver confirmed file-complete, ready for next file');
                }
                break;

            case 'cancel':
                if (modeRef.current === 'receiver') {
                    setReceiverStatus('error');
                    setReceiverError('Transfer cancelled by sender.');
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
        initDB().catch(() => { });
        registerDataHandlers(handleControlMessage, handleBinaryData, handleChannelState);
    }, [handleControlMessage, handleBinaryData, handleChannelState]);

    const handleFilesSelect = (files: File[]) => {
        setMode('sender');
        setFileQueue(files);
        setCurrentFileIndex(0);
        setSenderFile(files[0]);
        setSenderStatus('idle');
        setSenderError(null);
        setSenderProgress(null);
    };

    const handleSenderStart = (fileOverride?: File) => {
        const fileToSend = fileOverride || senderFile;
        if (!fileToSend) return;

        senderRef.current = new FileSender(
            fileToSend,
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

        setSenderStatus('waiting');
        sendControl({
            type: 'file-request',
            name: fileToSend.name,
            size: fileToSend.size,
            mimeType: fileToSend.type
        });
    };

    useEffect(() => {
        if (senderStatus === 'complete' && currentFileIndex < fileQueue.length - 1) {
            const nextIndex = currentFileIndex + 1;
            setCurrentFileIndex(nextIndex);
            setSenderFile(fileQueue[nextIndex]);
            setSenderStatus('idle');
            setSenderProgress(null);
            setTimeout(() => {
                handleSenderStart(fileQueue[nextIndex]);
            }, 1000);
        }
    }, [senderStatus, currentFileIndex, fileQueue]);

    const handleSenderAbort = () => {
        if (senderRef.current) senderRef.current.abort();

        if (mode === 'sender' && (senderStatus === 'uploading' || senderStatus === 'waiting' || senderStatus === 'paused')) {
            sendControl({ type: 'cancel' } as any);
        }

        setMode('idle');
        setSenderFile(null);
        setFileQueue([]);
        setCurrentFileIndex(0);
    };

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

    const handleAccept = () => {
        if (!receiverMeta) return;

        setReceiverStatus('receiving');
        receiverRef.current = new FileReceiver(
            receiverMeta,
            (progress) => setReceiverProgress(progress),
            (status, data) => {
                if (status === 'receiving' && data === 'finalizing') {
                    setReceiverStatus('finalizing');
                } else if (status === 'receiving') {
                    setReceiverStatus('receiving');
                }
                if (status === 'complete') {
                    setReceiverStatus('complete');
                    triggerDownload(data as Blob, receiverMeta.name);
                    // Auto-reset receiver after a brief delay to show completion
                    setTimeout(() => {
                        setMode('idle');
                        setReceiverMeta(null);
                        setReceiverStatus('idle');
                        setReceiverError(null);
                        setReceiverProgress(null);
                        receiverRef.current = null;
                    }, 500);
                }
                if (status === 'error') {
                    setReceiverStatus('error');
                    setReceiverError(data as string);
                }
            }
        );

        sendControl({ type: 'file-accept' });
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

    const setReceiverRef = (val: any) => { receiverRef.current = val; };

    return (
        <div className="app-container">
            <div style={{ maxWidth: '480px', width: '100%' }}>
                <div
                    className="glass-card-static"
                    style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.75rem',
                        padding: '1rem 1.25rem',
                        marginBottom: '0.75rem',
                        animation: 'fadeIn 0.5s ease-out'
                    }}
                >
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        flexWrap: 'wrap',
                        gap: '1rem'
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                            <div style={{
                                fontSize: '0.75rem',
                                fontWeight: 600,
                                color: 'var(--text-tertiary)',
                                textTransform: 'uppercase',
                                letterSpacing: '0.08em'
                            }}>
                                Room
                            </div>
                            <div style={{
                                fontSize: '1.125rem',
                                fontWeight: 500,
                                letterSpacing: '0.12em',
                                color: 'var(--text-primary)'
                            }}>
                                {roomId}
                            </div>
                        </div>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button
                                className="btn-ghost"
                                onClick={copyRoomId}
                                style={{
                                    padding: '0.5rem 0.875rem',
                                    fontSize: '0.8125rem'
                                }}
                            >
                                {copyFeedback ? (
                                    <>
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                            <polyline points="20 6 9 17 4 12"></polyline>
                                        </svg>
                                        Copied
                                    </>
                                ) : (
                                    <>
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                                        </svg>
                                        Copy
                                    </>
                                )}
                            </button>
                            <button
                                className="btn-ghost"
                                onClick={shareRoom}
                                style={{
                                    padding: '0.5rem 0.875rem',
                                    fontSize: '0.8125rem'
                                }}
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <circle cx="18" cy="5" r="3"></circle>
                                    <circle cx="6" cy="12" r="3"></circle>
                                    <circle cx="18" cy="19" r="3"></circle>
                                    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
                                    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
                                </svg>
                                Share
                            </button>
                            <button
                                className="btn-danger"
                                onClick={onLeave}
                                style={{
                                    padding: '0.5rem 0.875rem',
                                    fontSize: '0.8125rem'
                                }}
                            >
                                Leave
                            </button>
                        </div>
                    </div>
                </div>

                <StatusBar roomId={roomId} />

                <div style={{ marginTop: '0.75rem', animation: 'slideUp 0.5s ease-out 0.15s both' }}>
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
                            onStart={() => handleSenderStart()}
                            onPause={() => {
                                if (senderRef.current) senderRef.current.pause();
                                setSenderStatus('paused' as any);
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
