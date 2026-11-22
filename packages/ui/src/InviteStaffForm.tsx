import { useState, type FormEvent } from 'react';
import { Button } from './Button';
import { Card } from './Card';
import { Field, Input } from './Input';
import { PreviewNotice } from './Notices';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface InviteStaffFormProps {
  onSubmit: (email: string) => void;
  busy?: boolean;
  /** The staff invite has no BFF passthrough yet: show the preview notice. */
  preview?: boolean;
}

/** Invite a read-only staff member by email. */
export function InviteStaffForm({ onSubmit, busy, preview }: InviteStaffFormProps) {
  const [email, setEmail] = useState('');
  const [tried, setTried] = useState(false);
  const error = EMAIL.test(email.trim()) ? undefined : 'Enter a valid email address.';
  function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (busy || error) return;
    onSubmit(email.trim());
    setEmail('');
    setTried(false);
  }
  return (
    <Card
      title="Invite staff"
      description="Staff can read redemptions, the store, billing and usage."
    >
      <form className="grid max-w-md gap-4" onSubmit={submit} noValidate>
        {preview && <PreviewNotice />}
        <Field label="Email" error={tried ? error : undefined}>
          {({ id, invalid, describedBy }) => (
            <Input
              id={id}
              type="email"
              value={email}
              invalid={invalid}
              aria-describedby={describedBy}
              autoComplete="off"
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <div>
          <Button type="submit" loading={busy}>
            Send invite
          </Button>
        </div>
      </form>
    </Card>
  );
}
