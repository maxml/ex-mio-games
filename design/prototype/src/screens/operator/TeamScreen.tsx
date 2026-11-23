import { useState } from 'react';
import { TeamTemplate, type ActivityItem, type StaffMember } from '@ex-mio/ui';
import { useOperatorShell } from './shell';

/** Team and settings: the staff list, invite and audit trail have no operator route yet: all preview. */
export function TeamScreen({ readOnly, denied }: { readOnly: boolean; denied?: string }) {
  const { shell } = useOperatorShell(denied);
  const [invited, setInvited] = useState<string[]>([]);
  const staff: StaffMember[] = invited.map((email) => ({
    id: email,
    email,
    role: 'operator_staff',
    status: 'pending',
  }));
  const audit: ActivityItem[] = invited.map((email) => ({
    id: `invite-${email}`,
    title: `Invited ${email} (preview, not sent)`,
  }));
  return (
    <TeamTemplate
      shell={shell}
      readOnly={readOnly}
      staff={staff}
      audit={audit}
      onInvite={(email) => setInvited((cur) => [...cur, email])}
    />
  );
}
