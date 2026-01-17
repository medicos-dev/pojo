import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './app/App'
import './styles/base.css'
import './styles/retro.css'
import './styles/components.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
    // StrictMode can check for double-invokes. 
    // WebRTC init in useEffect([]) is safe, but be careful of double connections in dev.
    // We'll keep StrictMode for best practices.
    <React.StrictMode>
        <App />
    </React.StrictMode>,
)
