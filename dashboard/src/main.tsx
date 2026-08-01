import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './i18n';
import 'katex/dist/katex.min.css';
import './styles/global.css';
import { installChatAbortKeyboardShortcuts } from './utils/chat-abort-keyboard';
import { installRunTraceProbe } from './utils/run-trace';

installChatAbortKeyboardShortcuts();
installRunTraceProbe();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
