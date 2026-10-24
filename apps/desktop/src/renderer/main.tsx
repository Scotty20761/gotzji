import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { GotzjiApp } from './GotzjiApp.js';
import { StandaloneLogViewer } from './features/live/StandaloneLogViewer.js';
import { MutationApprovalPage } from './features/mutation-approval/MutationApprovalPage.js';
import './styles.css';
import './settings-extra.css';

const root = document.getElementById('root');
if (root === null) throw new Error('Renderer root is missing');

const isLogViewer = window.location.hash === '#log-viewer';
const isMutationApproval = window.location.hash === '#mutation-approval';

createRoot(root).render(
  <StrictMode>
    {window.gotzji !== undefined ? <GotzjiApp /> : isMutationApproval ? <MutationApprovalPage /> : isLogViewer ? <StandaloneLogViewer /> : <App />}
  </StrictMode>,
);
