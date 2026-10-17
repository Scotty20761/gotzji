import { useState, type ReactElement } from 'react';
import productPackage from '../../package.json' with { type: 'json' };
import { gotzjiReleaseNotes } from './gotzji-release-notes.js';
export function GotzjiVersionNotes(): ReactElement {
  const APP_VERSION = productPackage.version;
  const [open, setOpen] = useState(false); const [language, setLanguage] = useState<'th' | 'en'>('th'); const notes = gotzjiReleaseNotes(APP_VERSION);
  return <><p className="gotzji-owner">gotzji {APP_VERSION}{notes?.status === 'development' ? ' · รุ่นระหว่างพัฒนา ยังไม่เผยแพร่' : ''}</p><button onClick={() => setOpen(true)}>มีอะไรใหม่ในรุ่นนี้</button>
    {open && <dialog open aria-label="ข่าวสารรุ่น gotzji"><h2>gotzji {APP_VERSION}</h2><div className="gotzji-actions"><button onClick={() => setLanguage('th')}>ไทย</button><button onClick={() => setLanguage('en')}>English</button></div>
      {notes ? <ul>{notes[language].map((entry) => <li key={entry}>{entry}</li>)}</ul> : <p>{language === 'th' ? 'ยังไม่มีบันทึกสำหรับรุ่นนี้' : 'No notes are available for this version.'}</p>}<button onClick={() => setOpen(false)}>ปิด</button></dialog>}</>;
}
