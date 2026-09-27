import { useEffect, useState } from 'react';
import { InfoTip } from '../../../ui/InfoTip';
import { RowSelect, ValueRow } from './rows';
import { AutonomySections } from './AutonomySettings';

/**
 * Settings → Features: what Stem may DO beyond answering — personas mailing
 * each other, commands, coding agents, computer control. One policy each,
 * governing every conversation at once; App keeps everything about talking.
 */
export function FeaturesSettings() {
  return (
    <div>
      <MailSection />
      <AutonomySections />
    </div>
  );
}

/** The one mail guard rail: how far personas may talk among themselves per wave. */
function MailSection() {
  const [cap, setCap] = useState(10);

  useEffect(() => {
    void window.stem.getSettings().then((s) => setCap(s.mail.exchangeCap));
  }, []);

  function select(value: number) {
    setCap(value); // optimistic; persist + reconcile from the saved settings
    window.stem.updateMailSettings({ exchangeCap: value }).then((s) => setCap(s.mail.exchangeCap));
  }

  const options = [5, 10, 20, 50].map((n) => ({
    value: String(n),
    label: String(n),
    title: `${n} inter-persona mails per wave`
  }));
  // A hand-edited settings file may hold a value off the menu — show it as-is
  // rather than letting the select go blank.
  if (!options.some((o) => o.value === String(cap))) {
    options.push({ value: String(cap), label: String(cap), title: 'Set outside this menu' });
  }

  return (
    <>
      <div className="grp-head">Mail</div>
      <div className="group">
        <ValueRow
          label="Persona exchange limit"
          hint={
            <>
              Mails personas may send each other per wave{' '}
              <InfoTip label="About the exchange limit">
                When a mail conversation has several personas, they consult each other by mail. Each
                mail you send resets this budget; when a wave of persona-to-persona mail uses it up,
                the next reply is forced back to you instead of looping on.
              </InfoTip>
            </>
          }
        >
          <RowSelect
            ariaLabel="Persona exchange limit"
            value={String(cap)}
            options={options}
            onChange={(v) => select(Number(v))}
          />
        </ValueRow>
      </div>
    </>
  );
}

