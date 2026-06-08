import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './i18n';
import './styles/global.css';
import { installChatAbortKeyboardShortcuts } from './utils/chat-abort-keyboard';

installChatAbortKeyboardShortcuts();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
