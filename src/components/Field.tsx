import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';

interface FieldShell {
  label: string;
  hint?: ReactNode;
  error?: string | null;
}

type InputProps = FieldShell & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & { multiline?: false };
type AreaProps = FieldShell & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> & { multiline: true };

/**
 * Label + control + hint + error, wired together with ids so screen readers
 * read the hint and the error along with the label.
 */
export function Field(props: InputProps | AreaProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const { label, hint, error, className, multiline, ...rest } = props;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  const shared = {
    id,
    className: `field-control${className ? ` ${className}` : ''}`,
    'aria-describedby': describedBy,
    'aria-invalid': error ? true : undefined,
  };

  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      {hint && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
      {multiline ? (
        <textarea {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)} {...shared} />
      ) : (
        <input {...(rest as InputHTMLAttributes<HTMLInputElement>)} {...shared} />
      )}
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
