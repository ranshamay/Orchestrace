import { useEffect, useMemo, useRef, useState } from 'react';
import { loginWithGoogleIdToken, type AppGoogleAuthResponse } from '../../../lib/api';

declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: {
          initialize: (options: {
            client_id: string;
            callback: (response: { credential?: string }) => void;
          }) => void;
          renderButton: (
            parent: HTMLElement,
            options: { theme?: 'outline' | 'filled_blue'; size?: 'large' | 'medium' | 'small'; text?: string; shape?: string },
          ) => void;
          prompt: () => void;
        };
      };
    };
  }
}

type Props = {
  googleClientId: string;
  onAuthenticated: (result: AppGoogleAuthResponse) => void;
};

const GOOGLE_SCRIPT_ID = 'google-identity-client';
const GOOGLE_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

export function LoginGate({ googleClientId, onAuthenticated }: Props) {
  const buttonHostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [scriptReady, setScriptReady] = useState(false);

  const disabledReason = useMemo(() => {
    if (!googleClientId.trim()) {
      return 'Google Sign-In is not configured. Set ORCHESTRACE_GOOGLE_CLIENT_ID on the server.';
    }
    return '';
  }, [googleClientId]);

  useEffect(() => {
    if (!googleClientId.trim()) {
      return;
    }

    const existing = document.getElementById(GOOGLE_SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      if (window.google?.accounts?.id) {
        setScriptReady(true);
      } else {
        existing.addEventListener('load', () => setScriptReady(true), { once: true });
      }
      return;
    }

    const script = document.createElement('script');
    script.id = GOOGLE_SCRIPT_ID;
    script.src = GOOGLE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => setScriptReady(true);
    script.onerror = () => setError('Failed to load Google Identity script.');
    document.head.appendChild(script);
  }, [googleClientId]);

  useEffect(() => {
    if (!scriptReady || !buttonHostRef.current || !googleClientId.trim()) {
      return;
    }

    const googleIdentity = window.google?.accounts?.id;
    if (!googleIdentity) {
      return;
    }

    buttonHostRef.current.innerHTML = '';
    googleIdentity.initialize({
      client_id: googleClientId,
      callback: (response) => {
        const credential = typeof response?.credential === 'string' ? response.credential.trim() : '';
        if (!credential) {
          setError('Missing Google credential. Please try again.');
          return;
        }

        setIsLoading(true);
        setError('');
        void loginWithGoogleIdToken(credential)
          .then((result) => {
            onAuthenticated(result);
          })
          .catch((err) => {
            setError(err instanceof Error ? err.message : String(err));
          })
          .finally(() => {
            setIsLoading(false);
          });
      },
    });

    googleIdentity.renderButton(buttonHostRef.current, {
      theme: 'outline',
      size: 'large',
      text: 'signin_with',
      shape: 'pill',
    });
  }, [googleClientId, onAuthenticated, scriptReady]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h1 className="text-lg font-semibold">Sign in to Orchestrace</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          Continue with Google to access the dashboard and authenticated API routes.
        </p>

        {disabledReason ? (
          <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-200">
            {disabledReason}
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            <div ref={buttonHostRef} className="min-h-10" />
            {isLoading ? (
              <div className="text-xs text-slate-500 dark:text-slate-300">Signing in...</div>
            ) : null}
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-200">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}