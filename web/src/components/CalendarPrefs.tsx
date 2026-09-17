import { useState } from 'react';
import { DAY_SIZES, MONTH_OPTIONS, getPrefs, savePrefs, type Prefs } from '../prefs';
import { monthsLabel } from '../dates';

export default function CalendarPrefs() {
  const [prefs, setPrefs] = useState<Prefs>(getPrefs);

  const update = (patch: Partial<Prefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      savePrefs(next);
      return next;
    });
  };

  return (
    <div className="panel">
      <h2>Kalendarz</h2>
      <p className="muted notif-desc">Ustawienia zapisują się na tym urządzeniu.</p>

      <div className="prefs-field">
        <span>Zakres widoku</span>
        <div className="segmented">
          {MONTH_OPTIONS.map((m) => (
            <button key={m} type="button" className={`chip ${prefs.months === m ? 'active' : ''}`} onClick={() => update({ months: m })}>
              {monthsLabel(m)}
            </button>
          ))}
        </div>
      </div>

      <div className="prefs-field">
        <span>Szerokość dni</span>
        <div className="segmented">
          {DAY_SIZES.map((s) => (
            <button key={s.id} type="button" className={`chip ${prefs.daySize === s.id ? 'active' : ''}`} onClick={() => update({ daySize: s.id })}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
