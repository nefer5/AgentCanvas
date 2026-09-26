import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import EmbeddedCanvas from './EmbeddedCanvas'

const root = document.getElementById('root')

if (!root) {
  throw new Error('Missing #root element')
}

createRoot(root).render(
  <StrictMode>
    {new URLSearchParams(location.search).get('embed') === 'dsh' ? <EmbeddedCanvas /> : <App />}
  </StrictMode>,
)
