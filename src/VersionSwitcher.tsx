import React from 'react';

const VersionSwitcher: React.FC = () => {
    const isV3 = window.location.pathname === '/' || window.location.pathname === '/v3';
    const currentVersion = isV3 ? 'v3' : 'v2';
    const targetVersion = isV3 ? 'v2' : 'v3';

    const handleSwitch = () => {
        if (isV3) {
            window.location.href = '/v2';
        } else {
            window.location.href = '/v3';
        }
    };

    return (
        <div
            onClick={handleSwitch}
            style={{
                position: 'fixed',
                top: '20px',
                right: '20px',
                width: '50px',
                height: '50px',
                borderRadius: '50%',
                backgroundColor: isV3 ? '#333' : '#eee',
                color: isV3 ? '#fff' : '#000',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                zIndex: 10001,
                fontWeight: 'bold',
                boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
                border: '2px solid rgba(128, 128, 128, 0.3)',
                userSelect: 'none'
            }}
            title={`Switch to ${targetVersion}`}
        >
            {currentVersion.toUpperCase()}
        </div>
    );
};

export default VersionSwitcher;
