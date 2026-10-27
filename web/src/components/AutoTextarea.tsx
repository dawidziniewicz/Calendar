import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

// Pole tekstowe, które rośnie razem z treścią — cały tekst widać bez przewijania (np. długa nazwa usługi na rachunku).
export default function AutoTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  };
  useLayoutEffect(fit, [props.value]);
  useLayoutEffect(() => {
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  return <textarea ref={ref} {...props} className={`auto-textarea ${props.className ?? ''}`} />;
}
