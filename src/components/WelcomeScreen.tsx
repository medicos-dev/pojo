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

    return (
        <div className="app-container">
            <h1 style={{
                fontFamily: 'var(--font-heading)',
                fontSize: '3rem',
                color: 'var(--text-primary)',
                margin: 0,
                textAlign: 'center',
                marginBottom: '2rem'
            }}>
                POJO FILES
            </h1>

            <div className="retro-card" style={{ width: '100%', maxWidth: '400px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    <div>
                        <label className="font-mono text-muted" style={{ fontSize: '0.9rem' }}>ENTER ROOM CODE</label>
                        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                            <input
                                className="retro-input"
                                value={code}
                                onChange={(e) => setCode(e.target.value.toUpperCase())}
                                placeholder="A7X92B"
                                maxLength={6}
                                style={{ textAlign: 'center', letterSpacing: '0.2em', fontSize: '1.2rem', fontWeight: 'bold' }}
                            />
                            <button className="retro-btn" onClick={handleJoin} disabled={code.length < 3}>
                                JOIN
                            </button>
                        </div>
                    </div>

                    <div style={{ textAlign: 'center', opacity: 0.5, fontSize: '0.8rem' }} className="font-mono">
                        — OR —
                    </div>

                    <button className="retro-btn primary" onClick={onCreate}>
                        CREATE NEW ROOM
                    </button>
                </div>
            </div>

            <Footer />
        </div>
    );
};
