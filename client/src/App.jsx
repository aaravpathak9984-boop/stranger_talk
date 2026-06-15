import { useState, useRef, useEffect, useCallback } from 'react';
import { socket } from './socket';
import './App.css';

// ── Helpers ──────────────────────────────────────────────────────────────────
function formatTime(ts) {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}

let _msgId = 0;
const uid = () => ++_msgId + Math.random();

// ── Component ─────────────────────────────────────────────────────────────────
export default function App() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [status, setStatus]               = useState('idle');
  const [messages, setMessages]           = useState([]);
  const [inputText, setInputText]         = useState('');
  const [isPartnerTyping, setIsPartnerTyping] = useState(false);
  const [onlineCount, setOnlineCount]     = useState(0);
  const [agCode, setAgCode]               = useState(null);
  const [showAgModal, setShowAgModal]     = useState(false);
  const [reconnectInput, setReconnectInput] = useState('');
  const [agError, setAgError]             = useState(null);
  const [showReportMenu, setShowReportMenu] = useState(false);
  const [toast, setToast]                 = useState(null); // { text, type }

  // ── Refs ────────────────────────────────────────────────────────────────────
  const messagesEndRef  = useRef(null);
  const textareaRef     = useRef(null);
  const typingTimerRef  = useRef(null);
  const lastTypingEmit  = useRef(0);

  // ── Message helpers ─────────────────────────────────────────────────────────
  const addMsg = useCallback(({ text, mine, time }) => {
    setMessages(prev => [...prev, { id: uid(), text, mine, time, system: false }]);
  }, []);

  const addSystemMsg = useCallback((text) => {
    setMessages(prev => [...prev, { id: uid(), text, system: true }]);
  }, []);

  // ── Auto-scroll ─────────────────────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isPartnerTyping]);

  // ── Toast auto-dismiss ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // ── Socket events ───────────────────────────────────────────────────────────
  useEffect(() => {
    // Call .off before every .on so that React StrictMode’s double-invoke
    // never stacks up duplicate listeners on the same socket singleton.
    const on = (event, handler) => {
      socket.off(event);
      socket.on(event, handler);
    };

    on('waiting', () => {
      setStatus('waiting');
      setMessages([]);
      setIsPartnerTyping(false);
    });

    on('paired', (data) => {
      setStatus('chatting');
      addSystemMsg(data?.antigravity ? 'Reconnected via Antigravity' : 'Connected to a stranger');
    });

    on('receiveMessage', ({ text, timestamp }) => {
      addMsg({ text, mine: false, time: formatTime(timestamp) });
    });

    on('partnerTyping', () => {
      setIsPartnerTyping(true);
      clearTimeout(typingTimerRef.current);
      typingTimerRef.current = setTimeout(() => setIsPartnerTyping(false), 2000);
    });

    on('partnerLeft', () => {
      addSystemMsg('Stranger has left');
      setStatus('idle');
      setIsPartnerTyping(false);
      socket.disconnect();
    });

    on('partnerSkipped', () => {
      addSystemMsg('Stranger skipped');
      setStatus('idle');
      setIsPartnerTyping(false);
      socket.disconnect();
    });

    on('onlineCount', (count) => {
      setOnlineCount(count);
    });

    on('antigravityCode', ({ code }) => {
      setAgCode(code);
      setShowAgModal(true);
    });

    on('antigravityError', ({ message }) => {
      setAgError(message);
    });

    on('rateLimited', () => {
      addSystemMsg('Slow down — you\'re sending too fast');
    });

    on('messageTooLong', ({ max }) => {
      setToast({ text: `Message too long — max ${max} characters`, type: 'error' });
    });

    on('reportReceived', () => {
      setToast({ text: 'Report submitted', type: 'success' });
      setShowReportMenu(false);
    });

    socket.on('banned', ({ message }) => {
      addSystemMsg(message || 'You have been banned');
      setStatus('idle');
      socket.disconnect();
    });

    return () => {
      socket.off('waiting');
      socket.off('paired');
      socket.off('receiveMessage');
      socket.off('partnerTyping');
      socket.off('partnerLeft');
      socket.off('partnerSkipped');
      socket.off('onlineCount');
      socket.off('antigravityCode');
      socket.off('antigravityError');
      socket.off('rateLimited');
      socket.off('messageTooLong');
      socket.off('reportReceived');
      socket.off('banned');
      clearTimeout(typingTimerRef.current);
    };
  }, [addMsg, addSystemMsg]);

  // ── User action handlers ────────────────────────────────────────────────────

  const handleStartTalking = () => {
    socket.connect();
    setStatus('waiting');
    setMessages([]);
  };

  const handleAntigravityJoin = () => {
    const code = reconnectInput.trim().toUpperCase();
    if (code.length < 4) return;
    socket.connect();
    socket.emit('joinAntigravity', { code });
    setStatus('waiting');
    setMessages([]);
  };

  const handleSend = () => {
    const text = inputText.trim();
    if (!text || status !== 'chatting') return;
    socket.emit('sendMessage', { text, timestamp: Date.now() });
    addMsg({ text, mine: true, time: formatTime(Date.now()) });
    setInputText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = '40px';
    }
  };

  const handleTextareaChange = (e) => {
    const val = e.target.value;
    setInputText(val);

    // Auto-resize
    const ta = e.target;
    ta.style.height = '40px';
    ta.style.height = Math.min(ta.scrollHeight, 100) + 'px';

    // Throttled typing emit
    if (Date.now() - lastTypingEmit.current > 1000) {
      socket.emit('typing');
      lastTypingEmit.current = Date.now();
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSkip = () => {
    socket.emit('skip');
    setIsPartnerTyping(false);
  };

  const handleStayConnected = () => {
    socket.emit('generateAntigravity');
  };

  const handleReport = (reason) => {
    socket.emit('reportUser', { reason });
    // Optimistic feedback — server confirms with 'reportReceived'
    setShowReportMenu(false);
  };

  const handleCopyCode = () => {
    if (agCode) navigator.clipboard.writeText(agCode);
  };

  // ── Dev toolbar simulations (work offline, no real socket needed) ───────────
  const simWaiting = () => {
    setStatus('waiting');
    setMessages([]);
    setIsPartnerTyping(false);
  };

  const simPaired = () => {
    // Use the real helpers so system/mine flags are set correctly
    setStatus('chatting');
    setMessages([]);           // clear first so helpers append cleanly
    setIsPartnerTyping(false);
    setOnlineCount(1347);
    // Defer so setMessages([]) has flushed before we append
    setTimeout(() => {
      addSystemMsg('Connected to a stranger');
      addMsg({ text: "hey, what's up?", mine: false, time: formatTime(Date.now()) });
      addMsg({ text: 'not much, just testing this app 😄', mine: true, time: formatTime(Date.now()) });
      setIsPartnerTyping(true);
    }, 0);
  };

  const simMessage = () => {
    addMsg({ text: "hey, how's it going?", mine: false, time: formatTime(Date.now()) });
  };

  const simPartnerLeft = () => {
    addSystemMsg('Stranger has left');
    setStatus('idle');
    setIsPartnerTyping(false);
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
      <div className="app">

        {/* ── 1. TOPBAR ──────────────────────────────────────────────────── */}
        <header className="topbar">
          <div className="logo">
            <span className="logo-stranger">Stranger</span>
            <span className="logo-talk">Talk</span>
          </div>
          <div className="online-indicator">
            <span className="pulse-dot" />
            <span className="online-count">{onlineCount.toLocaleString()}</span>
            <span className="online-label">online</span>
          </div>
        </header>

        {/* ── 2. START OVERLAY ───────────────────────────────────────────── */}
        {status === 'idle' && (
          <div className="start-overlay">
            <div className="start-headline">
              <div>Talk to a</div>
              <div className="start-headline-accent">random stranger</div>
            </div>
            <p className="start-sub">No account. No trace. Just conversation.</p>

            <button id="btn-start-talking" className="btn-start" onClick={handleStartTalking}>
              Start talking
            </button>

            <div className="reconnect-section">
              <span className="reconnect-label">Have a reconnect code?</span>
              <div className="reconnect-row">
                <input
                  id="reconnect-code-input"
                  className="reconnect-input"
                  type="text"
                  placeholder="Enter code"
                  value={reconnectInput}
                  maxLength={12}
                  onChange={(e) => {
                    setReconnectInput(e.target.value.toUpperCase());
                    setAgError(null);
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && handleAntigravityJoin()}
                />
                <button id="btn-ag-go" className="btn-go" onClick={handleAntigravityJoin}>
                  Go
                </button>
              </div>
              {agError && (
                <span className="ag-error">{agError}</span>
              )}
            </div>
          </div>
        )}

        {/* ── 3. STATUS STRIP ────────────────────────────────────────────── */}
        {status !== 'idle' && (
          <div className={`status-strip status-strip--${status}`}>
            <span className={`status-dot${status === 'waiting' ? ' status-dot--pulse' : ''}`} />
            <span className="status-text">
              {status === 'waiting' ? 'Looking for a stranger...' : 'Connected to a stranger'}
            </span>
          </div>
        )}

        {/* ── 4. CHAT ACTIONS ROW ────────────────────────────────────────── */}
        {status === 'chatting' && (
          <div className="chat-actions">
            {/* Report button with dropdown */}
            <div className="report-wrap">
              <button
                id="btn-report"
                className="btn-report"
                onClick={() => setShowReportMenu(v => !v)}
              >
                Report
              </button>
              {showReportMenu && (
                <div className="report-menu" role="menu">
                  {['Spam', 'Inappropriate content', 'Harassment'].map((reason) => (
                    <button
                      key={reason}
                      className="report-menu-item"
                      role="menuitem"
                      onClick={() => handleReport(reason)}
                    >
                      {reason}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button id="btn-stay-connected" className="btn-stay" onClick={handleStayConnected}>
              Stay connected
            </button>
          </div>
        )}

        {/* ── 5. MESSAGES AREA ───────────────────────────────────────────── */}
        {status !== 'idle' && (
          <div className="messages-area" id="messages-area">
            {messages.map((msg) =>
              msg.system ? (
                <div key={msg.id} className="msg-system">{msg.text}</div>
              ) : (
                <div
                  key={msg.id}
                  className={`msg-wrap ${msg.mine ? 'msg-wrap--mine' : 'msg-wrap--theirs'}`}
                >
                  <div className={`bubble ${msg.mine ? 'bubble--mine' : 'bubble--theirs'}`}>
                    {msg.text}
                  </div>
                  {msg.time && (
                    <div className={`msg-time${msg.mine ? ' msg-time--mine' : ''}`}>
                      {msg.time}
                    </div>
                  )}
                </div>
              )
            )}

            {/* Typing indicator */}
            {isPartnerTyping && (
              <div className="typing-wrap">
                <div className="typing-indicator">
                  <span className="typing-dot" style={{ animationDelay: '0ms' }} />
                  <span className="typing-dot" style={{ animationDelay: '160ms' }} />
                  <span className="typing-dot" style={{ animationDelay: '320ms' }} />
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        )}

        {/* ── 6. BOTTOM BAR ──────────────────────────────────────────────── */}
        {status !== 'idle' && (
          <div className="bottom-bar">
            <textarea
              ref={textareaRef}
              id="chat-textarea"
              className="chat-input"
              placeholder="Type a message..."
              value={inputText}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              disabled={status !== 'chatting'}
              rows={1}
            />
            <button
              id="btn-send"
              className="btn-send"
              onClick={handleSend}
              disabled={status !== 'chatting'}
              aria-label="Send message"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M2 8L14 8M9 3L14 8L9 13"
                  stroke="#0A0A0A"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              id="btn-skip"
              className="btn-skip"
              onClick={handleSkip}
              disabled={status !== 'chatting'}
            >
              Skip
            </button>
          </div>
        )}

        {/* ── 7. ANTIGRAVITY MODAL ───────────────────────────────────────── */}
        {showAgModal && (
          <div
            className="modal-backdrop"
            id="ag-modal-backdrop"
            onClick={() => setShowAgModal(false)}
          >
            <div className="modal-box" onClick={(e) => e.stopPropagation()}>
              <div className="modal-label">Your reconnect code</div>
              <div className="modal-code" id="ag-modal-code">{agCode}</div>
              <p className="modal-hint">
                Share this code with your stranger so you can find each other again.
                <br />
                It expires when you close this session.
              </p>
              <div className="modal-actions">
                <button id="btn-copy-code" className="btn-copy" onClick={handleCopyCode}>
                  Copy code
                </button>
                <button id="btn-modal-done" className="btn-done" onClick={() => setShowAgModal(false)}>
                  Done
                </button>
              </div>
            </div>
          </div>
        )}

      </div>

      {/* ── DEV TOOLBAR (outside app, fixed to bottom) ─────────────────── */}
      <div className="dev-toolbar" id="dev-toolbar">
        <span className="dev-label">dev</span>
        <button className="dev-btn" onClick={simWaiting}>Simulate: waiting</button>
        <button className="dev-btn" onClick={simPaired}>Simulate: paired</button>
        <button className="dev-btn" onClick={simMessage}>Simulate: message</button>
        <button className="dev-btn dev-btn--danger" onClick={simPartnerLeft}>
          Simulate: partner left
        </button>
      </div>

      {/* ── TOAST ──────────────────────────────────────────────────────────── */}
      {toast && (
        <div className={`toast toast--${toast.type}`} role="status" aria-live="polite">
          {toast.text}
        </div>
      )}
    </>
  );
}
