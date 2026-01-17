import { useState } from 'react';

export const Footer = () => {
    const [showDonateModal, setShowDonateModal] = useState(false);
    const [showDevModal, setShowDevModal] = useState(false);

    return (
        <>
            <footer className="app-footer">
                <div className="footer-content">
                    <div className="developer-info" onClick={() => setShowDevModal(true)} style={{ cursor: 'pointer' }}>
                        <img src="/aiks.jpg" alt="Developer" className="developer-avatar" />
                        <span className="developer-name">AIKS</span>
                    </div>
                    <button className="btn-donate" onClick={() => setShowDonateModal(true)}>
                        💚 Donate
                    </button>
                </div>
            </footer>

            {showDevModal && (
                <div className="modal-overlay" onClick={() => setShowDevModal(false)}>
                    <div className="modal-content" onClick={e => e.stopPropagation()}>
                        <button className="modal-close" onClick={() => setShowDevModal(false)}>×</button>
                        <img src="/aiks.jpg" alt="Developer" className="donation-image" style={{ borderRadius: '50%', width: '300px', height: '300px', objectFit: 'cover' }} />
                    </div>
                </div>
            )}

            {showDonateModal && (
                <div className="modal-overlay" onClick={() => setShowDonateModal(false)}>
                    <div className="modal-content" onClick={e => e.stopPropagation()}>
                        <button className="modal-close" onClick={() => setShowDonateModal(false)}>×</button>
                        <img src="/donate.png" alt="Donation QR" className="donation-image" />
                    </div>
                </div>
            )}
        </>
    );
};
