import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { DepsResult } from '../types/ir';
import { getDeps, refreshDeps } from '../api/client';

interface Props {
  children: ReactNode;
}

const REQUIRED = ['manim', 'latex', 'ffmpeg'] as const;

export function DepGate({ children }: Props) {
  const [deps, setDeps] = useState<DepsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      const result = await getDeps();
      setDeps(result);
    } catch {
      setDeps(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const result = await refreshDeps();
      setDeps(result);
    } finally {
      setRefreshing(false);
    }
  };

  if (loading) {
    return (
      <div className="dep-gate dep-gate--loading">
        <p>Checking system dependencies…</p>
      </div>
    );
  }

  const backendDown = !deps;
  const missingRequired = !backendDown && REQUIRED.some(k => !deps![k]?.ok);

  if (backendDown || missingRequired) {
    return (
      <div className="dep-gate dep-gate--blocked">
        <div className="dep-gate__modal">
          <h2>Setup Required</h2>
          {backendDown ? (
            <p className="dep-gate__error">
              Cannot reach the backend at <code>http://localhost:8000</code>.
              Make sure you ran the start script (<code>.\scripts\start.ps1</code> on Windows,{' '}
              <code>bash scripts/start.sh</code> on macOS/Linux).
            </p>
          ) : (
            <>
              <p>
                One or more required dependencies are missing. Run the setup script to install them
                (<code>.\scripts\setup.ps1</code> on Windows, <code>bash scripts/setup.sh</code> on
                macOS/Linux).
              </p>
              <table className="dep-gate__table">
                <thead>
                  <tr><th>Dependency</th><th>Status</th><th>Details</th></tr>
                </thead>
                <tbody>
                  {Object.entries(deps!).map(([key, s]) => (
                    <tr key={key} className={s.ok ? '' : 'dep-gate__row--missing'}>
                      <td>{key}</td>
                      <td>{s.ok ? '✓ OK' : REQUIRED.includes(key as any) ? '✗ Required' : '⚠ Optional'}</td>
                      <td><code>{s.ok ? s.version : s.error}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <button onClick={handleRefresh} disabled={refreshing} className="dep-gate__btn">
            {refreshing ? 'Checking…' : 'Recheck Dependencies'}
          </button>
        </div>
      </div>
    );
  }

  // sympy missing — show dismissible banner
  const sympyMissing = deps && !deps['sympy']?.ok;

  return (
    <>
      {sympyMissing && (
        <div className="dep-banner">
          <strong>Optional:</strong> <code>sympy</code> is not installed — implicit function plots are disabled.
          Run <code>pip install sympy</code> in the backend venv to enable them.
        </div>
      )}
      {children}
    </>
  );
}
