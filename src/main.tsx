import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import Workspace from './Workspace.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Workspace />
  </StrictMode>,
)
