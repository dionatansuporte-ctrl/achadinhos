import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';

/**
 * Aviso do painel no lugar do alert() do navegador (que não aceita estilo).
 * Uso: notify('Automação atualizada.') · notify('Falhou', 'error') · notify('Atenção', 'info')
 */
export type NotifyKind = 'ok' | 'error' | 'info';
type Toast = { id: number; text: string; kind: NotifyKind };

let listeners: ((t: Toast) => void)[] = [];
let seq = 0;

export function notify(text: string, kind: NotifyKind = 'ok') {
  const t = { id: ++seq, text, kind };
  listeners.forEach(l => l(t));
}

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    const on = (t: Toast) => {
      setToasts(v => [...v, t]);
      // Erro fica até fechar; sucesso e info somem sozinhos.
      if (t.kind !== 'error') setTimeout(() => setToasts(v => v.filter(x => x.id !== t.id)), 4500);
    };
    listeners.push(on);
    return () => { listeners = listeners.filter(l => l !== on); };
  }, []);
  if (!toasts.length) return null;
  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map(t => (
        <div className={`toast toast-${t.kind}`} key={t.id}>
          {t.kind === 'ok' ? <CheckCircle2 size={22} /> : t.kind === 'error' ? <AlertTriangle size={22} /> : <Info size={22} />}
          <span>{t.text}</span>
          <button type="button" aria-label="Fechar" onClick={() => setToasts(v => v.filter(x => x.id !== t.id))}><X size={16} /></button>
        </div>
      ))}
    </div>
  );
}
