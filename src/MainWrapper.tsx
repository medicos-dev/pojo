import React, { Suspense, lazy } from 'react';
import VersionSwitcher from './VersionSwitcher';

const V2Loader = lazy(() => import('./v2/V2Loader'));
const V3Loader = lazy(() => import('./v3/V3Loader'));

const MainWrapper: React.FC = () => {
    // Simple routing based on window.location.pathname
    // Default is V3 (since pathname '/' should render V3)
    const isV2 = window.location.pathname.startsWith('/v2');

    return (
        <>
            <Suspense fallback={<div style={{
                height: '100vh',
                width: '100vw',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                backgroundColor: '#1a1a1a',
                color: '#fff'
            }}>Loading...</div>}>
                {isV2 ? <V2Loader /> : <V3Loader />}
            </Suspense>
            <VersionSwitcher />
        </>
    );
};

export default MainWrapper;
