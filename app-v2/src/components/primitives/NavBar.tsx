import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';

interface NavBarProps {
  title?: string;
  /**
   * When provided, renders a leading back button. Use `true` for a
   * browser-history back; provide a string path to route somewhere
   * specific.
   */
  back?: true | string;
  trailing?: ReactNode;
}

export function NavBar({ title, back, trailing }: NavBarProps) {
  const navigate = useNavigate();

  function handleBack() {
    if (back === true) {
      if (window.history.length > 1) navigate(-1);
      else navigate('/');
    } else if (typeof back === 'string') {
      navigate(back);
    }
  }

  return (
    <header
      className="sticky top-0 z-30 flex h-11 items-center gap-2 border-b border-border bg-surface/90 px-2 backdrop-blur"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      {back ? (
        <button
          type="button"
          onClick={handleBack}
          aria-label="Back"
          className="grid size-11 place-items-center rounded-full text-fg hover:bg-border/40"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 22 22"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M14 4L7 11l7 7" />
          </svg>
        </button>
      ) : (
        <span className="size-11" aria-hidden="true" />
      )}

      <h1 className="min-w-0 flex-1 truncate text-center text-[length:var(--text-body)] font-semibold">
        {title}
      </h1>

      <span className="flex size-11 items-center justify-end">{trailing}</span>
    </header>
  );
}
