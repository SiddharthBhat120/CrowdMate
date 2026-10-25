import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { timeAgo } from '../../shared/domain';
import type { ChatMessage, ChatRole } from '../../shared/protocol';
import { LIMITS } from '../../shared/protocol';
import { useNow } from '../sync/hooks';

interface ChatThreadProps {
  messages: ChatMessage[];
  me: ChatRole;
  onSend: (text: string) => Promise<void>;
  /** Shown when there are no messages yet. */
  emptyText: string;
  /** Who you are talking to, e.g. "the family". */
  inputLabel: string;
}

const NAMES: Record<ChatRole, string> = { family: 'Family', finder: 'Helper', staff: 'Event staff' };

/**
 * role="log" makes screen readers announce new messages as they arrive.
 */
export function ChatThread({ messages, me, onSend, emptyText, inputLabel }: ChatThreadProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const now = useNow(30_000);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setError(null);
    setText('');
    try {
      await onSend(value);
    } catch (err) {
      setText(value);
      setError(err instanceof Error ? err.message : 'Message not sent. Try again.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="chat">
      <ol className="chat-log" role="log" aria-label="Messages" ref={listRef}>
        {messages.length === 0 && <li className="chat-empty">{emptyText}</li>}
        {messages.map((m) => (
          <li key={m.id} className={`chat-msg${m.role === me ? ' is-mine' : ''}`}>
            <span className="chat-meta">
              {m.role === me ? 'You' : NAMES[m.role]}, {timeAgo(m.at, now)}
            </span>
            <span className="chat-text">{m.text}</span>
          </li>
        ))}
      </ol>
      <form className="chat-form" onSubmit={submit}>
        <label className="visually-hidden" htmlFor={inputId}>
          {inputLabel}
        </label>
        <input
          id={inputId}
          className="field-control"
          value={text}
          maxLength={LIMITS.chatText}
          placeholder="Type a message"
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
          aria-describedby={error ? errorId : undefined}
        />
        <button type="submit" className="btn btn-primary" disabled={!text.trim()}>
          Send
        </button>
      </form>
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
